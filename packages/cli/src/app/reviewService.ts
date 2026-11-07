import { displayName, parsePullRequestUrl } from "@walkdiff/providers"
import type { PullRequestRef } from "@walkdiff/providers"
import { changedUnitsOf, isBehaviourChange, ReviewStatus, untouchedReferences } from "@walkdiff/review-model"
import type { AcceptStackRequest, AddReviewRequest, AnalysisStep, PullRequestStack, ReviewModel, ReviewSummary, StackOffer, StepReporter } from "@walkdiff/review-model"
import type { AttachedCoverage } from "../reviewCommand.ts"
import type { CompletedAnalysis, Detection, ReviewStore } from "./reviewStore.ts"
import { canonicalUrl, memberUrl, mergedOrder, stackOfferFor } from "./stacks.ts"

export interface ReportRequest {
  readonly ref: PullRequestRef
  readonly ai: boolean
  readonly attachedCoverage: AttachedCoverage | undefined
  readonly reportStep: StepReporter
}

/** Produces and writes a report for a PR, returning the directory it wrote. */
export type ReportGenerator = (request: ReportRequest) => Promise<GeneratedReport>

export interface GeneratedReport {
  readonly model: ReviewModel
  readonly reportDir: string
}

/** The open PRs stacked with this one, undefined when it stands alone. */
export type StackFinder = (ref: PullRequestRef) => Promise<PullRequestStack | undefined>

export interface ReviewServiceDependencies {
  readonly generate: ReportGenerator
  /** Run beside each analysis. Its failures are logged, and never fail the review. */
  readonly findStack: StackFinder
  readonly log: (message: string) => void
}

/**
 * Adds reviews and analyzes them one at a time. One at a time because analyses of the same
 * repository share a cached clone, and to keep a long list from swamping the machine.
 */
export class ReviewService {
  readonly #store: ReviewStore
  readonly #generate: ReportGenerator
  readonly #findStack: StackFinder
  readonly #log: (message: string) => void
  readonly #waiting: number[] = []
  /** Where each running analysis is. Only ever one entry while analyses run one at a time. */
  readonly #steps = new Map<number, AnalysisStep>()
  #drained: Promise<void> = Promise.resolve()
  #running = false

  constructor(store: ReviewStore, { generate, findStack, log }: ReviewServiceDependencies) {
    this.#store = store
    this.#generate = generate
    this.#findStack = findStack
    this.#log = log
  }

  /**
   * Adds a review, or refreshes it if that PR is already on the list, using the AI choice made
   * this time: it decides whether code leaves the machine, so an old choice must not win. Throws
   * on a bad URL.
   */
  add(request: AddReviewRequest): ReviewSummary {
    const ref = parsePullRequestUrl(request.url.trim())
    const url = canonicalUrl(ref)
    const existing = this.#store.getByUrl(url)
    if (existing !== undefined) {
      this.#store.setAi(existing.id, request.ai)
      return this.refresh(existing.id) ?? existing
    }
    const added = this.#store.add({ url, host: ref.host, displayName: displayName(ref), ai: request.ai })
    this.#enqueue(added.id)
    return added
  }

  /** Runs the analysis again, for example after new commits. Undefined if there is no such review. */
  refresh(id: number): ReviewSummary | undefined {
    if (this.#store.get(id) === undefined) return undefined
    if (!this.#waiting.includes(id)) {
      this.#store.setStatus(id, ReviewStatus.Queued)
      this.#enqueue(id)
    }
    return this.#store.get(id)
  }

  /** The review list, with the step each running analysis is on and any stack to offer. */
  list(): ReviewSummary[] {
    const reviews = this.#store.list()
    const detections = this.#store.detections()
    const grouped = urlsByStack(reviews)
    return reviews.map((review) => ({ ...review, step: this.#steps.get(review.id) ?? null, stackOffer: offerOf(review, detections.get(review.id), grouped) }))
  }

  /** One review as the list shows it. Undefined if there is no such review. */
  summary(id: number): ReviewSummary | undefined {
    return this.list().find((review) => review.id === id)
  }

  /**
   * Groups the review with every member of the stack found from it, adding those not on the list
   * yet with the AI choice made now. Members already on the list join without being analyzed
   * again. Does nothing more when there's no offer, so a second click is harmless. Undefined if
   * there is no such review.
   */
  acceptStack(id: number, request: AcceptStackRequest): ReviewSummary | undefined {
    const review = this.summary(id)
    const offer = review?.stackOffer ?? null
    if (review === undefined || offer === null) return review
    const reviewed = parsePullRequestUrl(review.url)
    const urls = offer.members.map((member) => memberUrl(reviewed, member.number))
    const stackId = review.stack?.id ?? urls.map((url) => this.#store.getByUrl(url)?.stack?.id).find((found) => found !== undefined) ?? this.#store.createStack(offer.trunk)
    for (const url of urls) {
      if (this.#store.getByUrl(url) === undefined) this.add({ url, ai: request.ai })
    }
    const previous = this.#store.stackMembers(stackId).map((member) => member.url)
    this.#store.regroup(stackId, offer.trunk, mergedOrder(previous, urls))
    return this.summary(id)
  }

  /** "Not now": the members offered aren't offered again from this review. Undefined if there is no such review. */
  dismissStackOffer(id: number): ReviewSummary | undefined {
    const offer = this.summary(id)?.stackOffer ?? null
    if (offer !== null) this.#store.dismiss(id, offer.joining)
    return this.summary(id)
  }

  /**
   * Splits a stack back into single reviews. What each member found is turned down at the same
   * time, or every member would offer the stack straight back. False if there is no such stack.
   */
  ungroup(stackId: number): boolean {
    if (this.#store.stack(stackId) === undefined) return false
    for (const member of this.#store.stackMembers(stackId)) {
      const detection = this.#store.detectionOf(member.id)
      if (detection !== undefined) this.#store.dismiss(member.id, detection.stack.members.map(({ number }) => number))
    }
    this.#store.ungroup(stackId)
    return true
  }

  /** Removes a review. Its stack doesn't offer it back: the reviewer just chose to drop it. */
  remove(id: number): void {
    const review = this.#store.get(id)
    if (review?.stack != null) {
      const { number } = parsePullRequestUrl(review.url)
      for (const mate of this.#store.stackMembers(review.stack.id)) {
        if (mate.id !== id) this.#store.dismiss(mate.id, [number])
      }
    }
    this.#store.remove(id)
  }

  /** Resolves once the queue is empty. */
  idle(): Promise<void> {
    return this.#drained
  }

  #enqueue(id: number): void {
    this.#waiting.push(id)
    if (!this.#running) {
      this.#running = true
      this.#drained = this.#drain()
    }
  }

  async #drain(): Promise<void> {
    for (let id = this.#waiting.shift(); id !== undefined; id = this.#waiting.shift()) {
      await this.#analyze(id)
    }
    this.#running = false
  }

  async #analyze(id: number): Promise<void> {
    const review = this.#store.get(id)
    // It may have been removed while it waited.
    if (review === undefined) return
    this.#store.setStatus(id, ReviewStatus.Analyzing)
    const ref = parsePullRequestUrl(review.url)
    // Detection takes a request or two, so the offer shows while the analysis is still running.
    const detection = this.#detectStack(review, ref)
    try {
      const report = await this.#generate({
        ref,
        ai: review.ai,
        attachedCoverage: this.#store.attachedCoverageOf(id),
        reportStep: (step) => this.#steps.set(id, step),
      })
      if (this.#store.get(id) !== undefined) this.#store.markReady(id, summarize(report))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`${review.displayName}: ${message}`)
      if (this.#store.get(id) !== undefined) this.#store.markFailed(id, message)
    } finally {
      this.#steps.delete(id)
    }
    await detection
  }

  async #detectStack(review: ReviewSummary, ref: PullRequestRef): Promise<void> {
    try {
      const stack = await this.#findStack(ref)
      if (this.#store.get(review.id) !== undefined) this.#store.saveDetection(review.id, stack)
    } catch (error: unknown) {
      this.#log(`${review.displayName}: could not check whether it's part of a stack: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function offerOf(review: ReviewSummary, detection: Detection | undefined, grouped: ReadonlyMap<number, ReadonlySet<string>>): StackOffer | null {
  if (detection === undefined) return null
  const mates = review.stack === null ? undefined : grouped.get(review.stack.id)
  return stackOfferFor({ reviewed: parsePullRequestUrl(review.url), detected: detection.stack, grouped: mates ?? new Set(), dismissed: detection.dismissed }) ?? null
}

function urlsByStack(reviews: readonly ReviewSummary[]): ReadonlyMap<number, ReadonlySet<string>> {
  const grouped = new Map<number, Set<string>>()
  for (const review of reviews) {
    if (review.stack === null) continue
    const urls = grouped.get(review.stack.id) ?? new Set<string>()
    urls.add(review.url)
    grouped.set(review.stack.id, urls)
  }
  return grouped
}

function summarize({ model, reportDir }: GeneratedReport): CompletedAnalysis {
  const units = model.files.flatMap(changedUnitsOf)
  return {
    reportDir,
    title: model.pullRequest.title,
    author: model.pullRequest.author,
    securityLevel: model.risk.securityLevel,
    unitsToReview: units.filter((unit) => isBehaviourChange(unit.change)).length,
    untouchedReferences: units.reduce((sum, unit) => sum + untouchedReferences(unit).length, 0),
    findings: model.risk.findings.length,
    coverageSource: model.testCoverage?.source ?? null,
    head: { headSha: model.pullRequest.headSha, baseRef: model.pullRequest.baseRef },
  }
}
