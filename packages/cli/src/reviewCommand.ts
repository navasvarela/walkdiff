import { join } from "node:path"
import { analyzeChangedFiles, coverageFromArchives, coverageInPullRequest, createAiProvider, fetchCommits, readCoverage, readLocalChange, readWalkdiffConfig, reviewWithAi } from "@walkdiff/engine"
import type { AiProvider } from "@walkdiff/engine"
import { gitHostFor, parsePullRequestUrl, repositoryPath } from "@walkdiff/providers"
import type { HostTokens, PullRequestRef } from "@walkdiff/providers"
import { AiReviewStatus, AnalysisStep, LOCAL_CHANGE_HOST, REVIEW_MODEL_SCHEMA_VERSION, reviewModelSchema, securitySummary } from "@walkdiff/review-model"
import type { AiReview, CheckId, CommitSha, FileDiff, LocalChange, PullRequest, ReviewModel, StepReporter, TestCoverage } from "@walkdiff/review-model"
import type { AiOptions, LocalReviewOptions, ReviewOptions } from "./args.ts"
import { detectPullRequestUrl } from "./ciEnvironment.ts"
import type { CiEnvironment } from "./ciEnvironment.ts"
import { writeReport } from "./report.ts"
import { serveReport } from "./server.ts"
import type { ReportServer } from "./server.ts"

// One above the app's 4317, so the two can run together.
const PREFERRED_REPORT_PORT = 4318
const ANY_FREE_PORT = 0


export interface AnalysisDependencies {
  readonly tokens: HostTokens
  readonly cacheDir: string
  readonly now: () => Date
  readonly log: (message: string) => void
  /** Told as each step of the analysis starts. */
  readonly reportStep: StepReporter
}

export interface ReviewDependencies extends AnalysisDependencies {
  readonly env: CiEnvironment
  /** Where Walkdiff was started, which --local reviews the repository of. */
  readonly cwd: string
}

/** What an analysis needs to know, whichever command asked for it. */
export interface AnalysisRequest {
  readonly network: boolean
  /** A report named on the command line; undefined looks for one on its own. */
  readonly coveragePath: string | undefined
  readonly attachedCoverage?: AttachedCoverage | undefined
  readonly ai: AiOptions | undefined
  readonly disabledChecks?: readonly CheckId[]
}

/** Coverage a reviewer chose for a PR, which only describes the commit it was attached to. */
export interface AttachedCoverage {
  readonly headSha: string
  readonly coverage: TestCoverage
}

interface Review {
  readonly model: ReviewModel
  readonly reportDir: string
}

export async function runReview(options: ReviewOptions, deps: ReviewDependencies): Promise<void> {
  const { model, reportDir } = options.local === undefined ? await reviewPullRequest(options, deps) : await reviewLocalBranch(options.local, options, deps)
  await writeReport(model, reportDir)

  deps.log(`${model.files.length} files changed, ${securitySummary(model.risk.findings).toLowerCase()}. Report written to ${reportDir}`)
  if (!options.serve) {
    return
  }
  const server = await serveReportOnPreferredPort(reportDir, options.port)
  deps.log(`Serving the report at ${server.url} (Ctrl+C to stop)`)
}

/**
 * Prefers a fixed port because browsers keep saved data per origin, including the port: a new
 * port on every run would lose the reviewer's progress and comments.
 */
async function serveReportOnPreferredPort(reportDir: string, port: number | undefined): Promise<ReportServer> {
  if (port !== undefined) return serveReport(reportDir, port)
  try {
    return await serveReport(reportDir, PREFERRED_REPORT_PORT)
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return serveReport(reportDir, ANY_FREE_PORT)
    throw error
  }
}

async function reviewPullRequest(options: ReviewOptions, deps: ReviewDependencies): Promise<Review> {
  const ref = parsePullRequestUrl(options.url ?? (await detectPullRequestUrl(deps.env)))
  const model = await analyzePullRequest(ref, options, deps)
  return { model, reportDir: options.outDir ?? defaultReportDir(deps.cacheDir, ref) }
}

// Reads the user's own repository in place: nothing is fetched, and nothing in it is changed.
async function reviewLocalBranch(local: LocalReviewOptions, options: ReviewOptions, deps: ReviewDependencies): Promise<Review> {
  const { repoDir, change, uncommittedFiles } = await readLocalChange({ cwd: deps.cwd, baseRef: local.baseRef })
  if (uncommittedFiles > 0) {
    deps.log(`${uncommittedFiles} ${uncommittedFiles === 1 ? "file has" : "files have"} uncommitted changes, which this review leaves out. Commit them to include them.`)
  }
  deps.log(`Reviewing ${change.headRef} against ${change.baseRef} in ${repoDir}.`)
  const model = await analyzeChange({ repoDir, pullRequest: change, ref: undefined }, options, deps)
  return { model, reportDir: options.outDir ?? localReportDir(deps.cacheDir, change) }
}

export async function analyzePullRequest(ref: PullRequestRef, options: AnalysisRequest, deps: AnalysisDependencies): Promise<ReviewModel> {
  deps.reportStep(AnalysisStep.FetchingPullRequest)
  const snapshot = await gitHostFor(ref, deps.tokens).fetchPullRequest()
  const { pullRequest } = snapshot

  deps.reportStep(AnalysisStep.FetchingCommits)
  const repoDir = await fetchCommits({
    cacheDir: deps.cacheDir,
    cloneUrl: snapshot.cloneUrl,
    credentials: snapshot.gitAuth,
    commits: [pullRequest.mergeBaseSha, pullRequest.headSha],
  })
  return analyzeChange({ repoDir, pullRequest, ref }, options, deps)
}

/** A change whose commits are in `repoDir`. `ref` names its pull request, when it has one. */
interface ChangeToAnalyze {
  readonly repoDir: string
  readonly pullRequest: PullRequest
  readonly ref: PullRequestRef | undefined
}

async function analyzeChange({ repoDir, pullRequest, ref }: ChangeToAnalyze, options: AnalysisRequest, deps: AnalysisDependencies): Promise<ReviewModel> {
  const { files, risk } = await analyzeChangedFiles(repoDir, pullRequest.mergeBaseSha, pullRequest.headSha, {
    network: options.network,
    disabledChecks: options.disabledChecks ?? [],
    reportStep: deps.reportStep,
  })
  const config = await readWalkdiffConfig(repoDir, pullRequest.mergeBaseSha)
  deps.reportStep(AnalysisStep.FindingCoverage)
  const testCoverage = await coverageFor(options, { ref, repoDir, headSha: pullRequest.headSha, diffs: files.map((file) => file.diff), patterns: config.coverage.paths }, deps)
  if (options.ai !== undefined) deps.reportStep(AnalysisStep.ReviewingWithAi)
  const ai: AiReview =
    options.ai === undefined
      ? { status: AiReviewStatus.Disabled }
      : await reviewWithAi({
          repoDir,
          base: pullRequest.mergeBaseSha,
          head: pullRequest.headSha,
          context: { pullRequest, files, risk },
          provider: announced(createAiProvider(options.ai, process.env), deps),
          cacheDir: deps.cacheDir,
          maxInputTokens: options.ai.maxInputTokens,
        })
  deps.log(describeAiReview(ai))
  // Validating our own output catches engine bugs here rather than as a broken report.
  return reviewModelSchema.parse({
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: deps.now().toISOString(),
    pullRequest,
    files,
    risk,
    ai,
    testCoverage,
    feedbackUrl: config.feedback.url,
  })
}

interface CoverageSearch {
  /** Undefined for a local branch, which has no CI runs to look in. */
  readonly ref: PullRequestRef | undefined
  readonly repoDir: string
  readonly headSha: CommitSha
  readonly diffs: readonly FileDiff[]
  readonly patterns: readonly string[]
}

/** The most deliberate source wins: what a person named, then CI's run of this commit, then the PR. */
async function coverageFor(options: AnalysisRequest, search: CoverageSearch, deps: AnalysisDependencies): Promise<TestCoverage | null> {
  if (options.coveragePath !== undefined) return readCoverage(options.coveragePath, search.diffs)
  if (options.attachedCoverage?.headSha === search.headSha) return options.attachedCoverage.coverage
  const found = (options.network ? await coverageFromCi(search, deps) : undefined) ?? (await coverageInPullRequest(search.repoDir, search.headSha, search.diffs, search.patterns))
  deps.log(found === undefined ? "No coverage report found for this commit." : `Test coverage from ${found.source}.`)
  return found ?? null
}

// Coverage only adds evidence, so a token without access to CI must not cost the whole review.
async function coverageFromCi(search: CoverageSearch, deps: AnalysisDependencies): Promise<TestCoverage | undefined> {
  if (search.ref === undefined) return undefined
  try {
    const archives = await gitHostFor(search.ref, deps.tokens).fetchCoverageArchives(search.headSha)
    return coverageFromArchives(archives, search.diffs, search.patterns)
  } catch (error: unknown) {
    deps.log(`Could not read CI artifacts: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

// Printed on every run, as this is the one place code can leave for a service the person chose.
function announced(provider: AiProvider, deps: AnalysisDependencies): AiProvider {
  deps.log(`AI review sends the changed code to ${provider.destination.label}.`)
  return provider
}

function describeAiReview(ai: AiReview): string {
  switch (ai.status) {
    case AiReviewStatus.Disabled:
      return "AI review off. Turn it on with --ai, or with Include AI review in the app."
    case AiReviewStatus.Unavailable:
      return `AI review not available: ${ai.reason}.`
    case AiReviewStatus.Completed: {
      const cost = ai.estimatedCostUsd === null ? "" : `, about $${ai.estimatedCostUsd.toFixed(2)}`
      const source = ai.cached ? "from cache" : `${ai.usage.inputTokens} input and ${ai.usage.outputTokens} output tokens${cost}`
      return `AI review by ${ai.model}: ${ai.chapters.length} chapters, ${ai.questions.length} questions, ${ai.droppedStatements} uncited statements dropped (${source}).`
    }
  }
}

export function defaultReportDir(cacheDir: string, ref: PullRequestRef): string {
  return join(cacheDir, "reports", new URL(ref.webOrigin).host, repositoryPath(ref), String(ref.number))
}

// Branch names hold slashes (`feature/parser`), which become folders; git refuses `..` in them.
function localReportDir(cacheDir: string, change: LocalChange): string {
  return join(cacheDir, "reports", LOCAL_CHANGE_HOST, change.repositoryName, ...change.headRef.split("/"))
}

