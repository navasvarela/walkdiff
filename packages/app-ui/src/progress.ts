import { parseProgressRecord, progressKey } from "@walkdiff/review-model"
import type { ProgressRecord } from "@walkdiff/review-model"

/** What the report saved in this browser; undefined if it was never opened here, or storage is off. */
export function readProgress(pullRequestUrl: string): ProgressRecord | undefined {
  try {
    return parseProgressRecord(window.localStorage.getItem(progressKey(pullRequestUrl)))
  } catch {
    return undefined
  }
}

export function progressLabel(progress: ProgressRecord | undefined): string {
  if (progress === undefined) return "not started"
  if (progress.total === 0) return "nothing to mark as reviewed"
  if (progress.reviewed === 0) return "not started"
  if (progress.reviewed === progress.total) return "✓ reviewed"
  return `${progress.reviewed} of ${progress.total} reviewed`
}
