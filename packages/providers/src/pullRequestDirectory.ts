import type { PullRequestListing } from "@walkdiff/review-model"
import { displayName, parsePullRequestUrl, repositoryPath } from "./pullRequestUrl.ts"

/**
 * The PRs worth reviewing from where an editor is: the one for the branch checked out, and those
 * waiting for the user's review. Unlike `GitHost`, it isn't tied to one PR, only to a repository
 * and its host.
 */
export interface PullRequestDirectory {
  /** Open PRs from this branch into the repository it's in. There can be several, into different bases. */
  openFromBranch(branch: string): Promise<readonly PullRequestListing[]>
  /**
   * Open PRs anywhere on the repository's host that ask the signed-in user for a review, most
   * recently updated first.
   *
   * # Errors
   *
   * Throws a `NotSignedInError` without a token, since the host can't say who "me" is.
   */
  awaitingMyReview(): Promise<readonly PullRequestListing[]>
}

export class NotSignedInError extends Error {
  override readonly name = "NotSignedInError"
}

/** How many PRs `awaitingMyReview` lists: one page, as more is too many to pick from. */
export const MAX_REVIEW_REQUESTS = 50

export interface ListedDetails {
  readonly url: string
  readonly title: string
  readonly author: string
  readonly draft: boolean
  readonly updatedAt: string
}

/** A listing named and numbered from its own link, which every host gives. */
export function listingFrom(details: ListedDetails): PullRequestListing {
  const ref = parsePullRequestUrl(details.url)
  return { ...details, host: ref.host, displayName: displayName(ref), repository: repositoryPath(ref), number: ref.number }
}
