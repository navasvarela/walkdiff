import { HostApiError, InvalidRemoteUrlError, NotSignedInError, parseRemoteUrl } from "@walkdiff/providers"
import type { PullRequestDirectory, RepositoryRef, TrustedOrigins } from "@walkdiff/providers"
import type { PullRequestListing } from "@walkdiff/review-model"

/** How to reach a repository's host, with its token. Tests replace it. */
export type DirectoryResolver = (repository: RepositoryRef) => Promise<PullRequestDirectory>

export const PullRequestLookup = { FromBranch: "fromBranch", AwaitingMyReview: "awaitingMyReview" } as const
export type PullRequestLookup = (typeof PullRequestLookup)[keyof typeof PullRequestLookup]

export interface LookupAnswer {
  readonly status: number
  readonly body: readonly PullRequestListing[] | { readonly error: string }
}

export interface LookupContext {
  readonly directoryFor: DirectoryResolver
  readonly trustedOrigins: TrustedOrigins
}

const BAD_REQUEST = 400
const FORBIDDEN = 403
const BAD_GATEWAY = 502
const OK = 200

/**
 * Answers a plugin asking which PRs it could review, from the git remote of the repository it has
 * open: the open PRs from a branch (`remote` and `branch`), or those waiting for the user's review
 * on that remote's host (`remote` alone).
 */
export async function lookUpPullRequests(lookup: PullRequestLookup, query: URLSearchParams, context: LookupContext): Promise<LookupAnswer> {
  const remote = query.get("remote") ?? ""
  const branch = query.get("branch") ?? ""
  if (remote === "") return failure(BAD_REQUEST, "Ask with the repository's git remote, as remote=<url>.")
  if (lookup === PullRequestLookup.FromBranch && branch === "") return failure(BAD_REQUEST, "Ask with the branch, as branch=<name>.")
  try {
    const directory = await context.directoryFor(parseRemoteUrl(remote, context.trustedOrigins))
    const listed = lookup === PullRequestLookup.FromBranch ? await directory.openFromBranch(branch) : await directory.awaitingMyReview()
    return { status: OK, body: listed }
  } catch (error: unknown) {
    return failureFor(error)
  }
}

function failureFor(error: unknown): LookupAnswer {
  if (error instanceof InvalidRemoteUrlError) return failure(BAD_REQUEST, error.message)
  if (error instanceof NotSignedInError) return failure(FORBIDDEN, error.message)
  // The host's own answer, such as a token it refused, is news for the user.
  if (error instanceof HostApiError) return failure(BAD_GATEWAY, error.message)
  throw error
}

function failure(status: number, error: string): LookupAnswer {
  return { status, body: { error } }
}
