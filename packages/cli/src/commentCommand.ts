import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { gitHostFor, HostApiError, parsePullRequestUrl } from "@walkdiff/providers"
import type { HostTokens } from "@walkdiff/providers"
import { LogLevel, reviewModelSchema } from "@walkdiff/review-model"
import type { Log } from "@walkdiff/review-model"
import type { CommentOptions } from "./args.ts"
import { REVIEW_MODEL_FILE } from "./report.ts"
import { renderSummaryComment, SUMMARY_COMMENT_MARKER } from "./summaryComment.ts"

export interface CommentDependencies {
  readonly tokens: HostTokens
  /** GitHub Actions' job summary file, written so the result is visible without a comment. */
  readonly stepSummaryPath: string | undefined
  readonly log: Log
}

/**
 * Posts the summary to the PR. A token without write access is expected, not a failure:
 * a PR from a fork gets a read-only token, and the job summary still carries the result.
 */
export async function runComment(options: CommentOptions, deps: CommentDependencies): Promise<void> {
  const text = await readFile(join(options.reportDir, REVIEW_MODEL_FILE), "utf8")
  const model = reviewModelSchema.parse(JSON.parse(text))
  const body = renderSummaryComment(model, options.reportUrl)

  if (deps.stepSummaryPath !== undefined) {
    await appendFile(deps.stepSummaryPath, `${body}\n`)
  }
  const host = gitHostFor(parsePullRequestUrl(model.pullRequest.url), deps.tokens)
  try {
    await host.upsertComment({ marker: SUMMARY_COMMENT_MARKER, body })
    deps.log("Posted the summary comment.")
  } catch (error: unknown) {
    if (!(error instanceof HostApiError) || !error.isPermissionProblem) throw error
    deps.log(`Could not post the summary comment (this token may be read-only): ${error.message}`, { level: LogLevel.Warn })
  }
}
