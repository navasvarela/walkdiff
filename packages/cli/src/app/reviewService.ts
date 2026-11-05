import { displayName, parsePullRequestUrl, repositoryPath } from "@walkdiff/providers"
import type { PullRequestRef } from "@walkdiff/providers"
import { changedUnitsOf, isBehaviourChange, ReviewStatus, untouchedReferences } from "@walkdiff/review-model"
import type { AddReviewRequest, AnalysisStep, ReviewModel, ReviewSummary, StepReporter } from "@walkdiff/review-model"
import type { AttachedCoverage } from "../reviewCommand.ts"
import type { CompletedAnalysis, ReviewStore } from "./reviewStore.ts"

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

/**
 * Adds reviews and analyzes them one at a time. One at a time because analyses of the same
 * repository share a cached clone, and to keep a long list from swamping the machine.
 */
export class ReviewService {
  readonly #store: ReviewStore
  readonly #generate: ReportGenerator
  readonly #log: (message: string) => void
  readonly #waiting: number[] = []
  /** Where each running analysis is. Only ever one entry while analyses run one at a time. */
  readonly #steps = new Map<number, AnalysisStep>()
  #drained: Promise<void> = Promise.resolve()
  #running = false

  constructor(store: ReviewStore, generate: ReportGenerator, log: (message: string) => void) {
    this.#store = store
    this.#generate = generate
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

  /** The review list, with the step each running analysis is on. */
  list(): ReviewSummary[] {
    return this.#store.list().map((review) => ({ ...review, step: this.#steps.get(review.id) ?? null }))
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
    try {
      const report = await this.#generate({
        ref: parsePullRequestUrl(review.url),
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
  }
}

/** One row per PR, however its URL was pasted (`/files`, trailing slash, and so on). */
function canonicalUrl(ref: PullRequestRef): string {
  const path = ref.host === "github" ? "pull" : "-/merge_requests"
  return `${ref.webOrigin}/${repositoryPath(ref)}/${path}/${ref.number}`
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
  }
}
