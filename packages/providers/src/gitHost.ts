import type { Conversation, PullRequest, PullRequestStack, PullRequestStatus, SubmitResult, SubmitReview } from "@walkdiff/review-model"
import type { MarkedComment } from "./markedComment.ts"
import type { TrustedOrigins } from "./trustedHosts.ts"

/** Credentials for git's HTTP transport, sent as Basic auth. */
export interface GitHttpAuth {
  readonly username: string
  readonly token: string
}

export interface PullRequestSnapshot {
  readonly pullRequest: PullRequest
  readonly cloneUrl: string
  readonly gitAuth: GitHttpAuth | undefined
}

/** An archive from CI's runs of one commit, which may hold a coverage report. */
export interface CiArchive {
  readonly name: string
  readonly zip: Buffer
}

// Matches what teams usually call these. Downloads are capped since each can be large, and a
// commit's CI can produce many unrelated archives.
export const COVERAGE_ARCHIVE_NAME = /cov|lcov|cobertura/i
export const MAX_COVERAGE_ARCHIVES = 5
export const MAX_COVERAGE_ARCHIVE_BYTES = 200 * 1024 * 1024

export interface GitHost {
  fetchPullRequest(): Promise<PullRequestSnapshot>
  /** Whether it's still open, and its head and base now. One request, unlike `fetchPullRequest`. */
  fetchStatus(): Promise<PullRequestStatus>
  /** Posts the comment, or replaces the earlier one carrying the same marker. */
  upsertComment(comment: MarkedComment): Promise<void>
  /** The review threads and who has approved, as the host has them now. */
  fetchConversation(): Promise<Conversation>
  /** Posts a review with its comments, and resolves to a link to it. */
  submitReview(review: SubmitReview): Promise<SubmitResult>
  replyToThread(threadId: string, body: string): Promise<void>
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>
  /** Archives CI kept for this commit whose names suggest coverage, newest first. */
  fetchCoverageArchives(headSha: string): Promise<readonly CiArchive[]>
  /** The open PRs stacked with this one, from the host's own stacks or by following branches. Undefined when it stands alone. */
  fetchStack(): Promise<PullRequestStack | undefined>
}

export interface HostTokens {
  readonly github: string | undefined
  readonly gitlab: string | undefined
  readonly trustedOrigins: TrustedOrigins
}
