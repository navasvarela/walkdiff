import { parseProgressRecord, progressKey } from "@walkdiff/review-model"
import type { ProgressRecord, ReportHead, ReviewSummary } from "@walkdiff/review-model"

export const ProgressStage = { NotStarted: "notStarted", Partly: "partly", Done: "done", Changed: "changed", NothingToReview: "nothingToReview" } as const

/** How far the reviewer got through a review's current report, as far as this browser knows. */
export type ReviewProgress = {
  /** Comments written in the report and not posted. They outlive a new push, so an older record still counts. */
  readonly drafts: number
} & (
  | { readonly stage: typeof ProgressStage.NotStarted }
  | { readonly stage: typeof ProgressStage.Partly; readonly reviewed: number; readonly total: number }
  | { readonly stage: typeof ProgressStage.Done }
  /** Reviewed in part or whole before a refresh; the new report hasn't been opened since. */
  | { readonly stage: typeof ProgressStage.Changed }
  | { readonly stage: typeof ProgressStage.NothingToReview }
)

export function readProgress(review: ReviewSummary): ReviewProgress {
  return progressOf(readRecord(review.url), review.reportHead)
}

/**
 * A record counted on another report says nothing about how much of this one was reviewed: the
 * report re-marks changed code as unreviewed only when it is opened.
 */
export function progressOf(record: ProgressRecord | undefined, reportHead: ReportHead | null): ReviewProgress {
  if (record === undefined) return { stage: ProgressStage.NotStarted, drafts: 0 }
  const { drafts, reviewed, total } = record
  const current = isSameReport(record.head, reportHead)
  if (current && total === 0) return { stage: ProgressStage.NothingToReview, drafts }
  if (reviewed === 0) return { stage: ProgressStage.NotStarted, drafts }
  if (!current) return { stage: ProgressStage.Changed, drafts }
  return reviewed === total ? { stage: ProgressStage.Done, drafts } : { stage: ProgressStage.Partly, reviewed, total, drafts }
}

export function progressLabel(progress: ReviewProgress): string {
  const unposted = progress.drafts === 0 ? "" : `, ${progress.drafts} ${progress.drafts === 1 ? "comment" : "comments"} not posted`
  return `${stageLabel(progress)}${unposted}`
}

function stageLabel(progress: ReviewProgress): string {
  switch (progress.stage) {
    case ProgressStage.NotStarted:
      return "not started"
    case ProgressStage.Partly:
      return `${progress.reviewed} of ${progress.total} reviewed`
    case ProgressStage.Done:
      return "✓ reviewed"
    case ProgressStage.Changed:
      return "changed since you reviewed it"
    case ProgressStage.NothingToReview:
      return "nothing to mark as reviewed"
  }
}

function isSameReport(saved: ReportHead, current: ReportHead | null): boolean {
  return current !== null && saved.headSha === current.headSha && saved.baseRef === current.baseRef
}

/** What the report saved in this browser; undefined if it was never opened here, or storage is off. */
function readRecord(pullRequestUrl: string): ProgressRecord | undefined {
  try {
    return parseProgressRecord(window.localStorage.getItem(progressKey(pullRequestUrl)))
  } catch {
    return undefined
  }
}
