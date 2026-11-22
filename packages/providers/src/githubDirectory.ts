import type { PullRequestListing } from "@walkdiff/review-model"
import { z } from "zod"
import { githubApiBase, githubHeaders } from "./github.ts"
import { getJson } from "./http.ts"
import { listingFrom, MAX_REVIEW_REQUESTS, NotSignedInError } from "./pullRequestDirectory.ts"
import type { PullRequestDirectory } from "./pullRequestDirectory.ts"
import type { GitHubRepositoryRef } from "./pullRequestUrl.ts"

const AUTH_HINT = "Set GITHUB_TOKEN (or GH_TOKEN) to a token that can read this repository, or sign in with the GitHub CLI."
const DELETED_USER_LOGIN = "ghost"
const PULLS_PER_PAGE = 100
// `review-requested` also matches requests to the user's teams; `user-review-requested` wouldn't.
const AWAITING_MY_REVIEW_QUERY = "is:open is:pr review-requested:@me archived:false"

/** A PR as both the pulls list and search results give it. */
const listedSchema = z.object({
  html_url: z.url(),
  title: z.string(),
  // Null for accounts that have since been deleted.
  user: z.object({ login: z.string() }).nullable(),
  draft: z.boolean().default(false),
  updated_at: z.string(),
})
type Listed = z.infer<typeof listedSchema>

const searchSchema = z.object({ items: z.array(listedSchema) })

export class GitHubDirectory implements PullRequestDirectory {
  readonly #repository: GitHubRepositoryRef
  readonly #token: string | undefined

  constructor(repository: GitHubRepositoryRef, token: string | undefined) {
    this.#repository = repository
    this.#token = token
  }

  async openFromBranch(branch: string): Promise<readonly PullRequestListing[]> {
    const { owner, repo, webOrigin } = this.#repository
    // Naming the head as `owner:branch` leaves out PRs from forks' branches of the same name.
    const head = encodeURIComponent(`${owner}:${branch}`)
    const url = `${githubApiBase(webOrigin)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&head=${head}&per_page=${PULLS_PER_PAGE}`
    return (await this.#get(url, z.array(listedSchema))).map(toListing)
  }

  async awaitingMyReview(): Promise<readonly PullRequestListing[]> {
    if (this.#token === undefined) throw new NotSignedInError(`Walkdiff needs your GitHub login to find PRs waiting for your review. ${AUTH_HINT}`)
    const url = `${githubApiBase(this.#repository.webOrigin)}/search/issues?q=${encodeURIComponent(AWAITING_MY_REVIEW_QUERY)}&sort=updated&order=desc&per_page=${MAX_REVIEW_REQUESTS}`
    return (await this.#get(url, searchSchema)).items.map(toListing)
  }

  #get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    return getJson({ url, headers: githubHeaders(this.#token), schema, authHint: AUTH_HINT })
  }
}

function toListing(pull: Listed): PullRequestListing {
  return listingFrom({ url: pull.html_url, title: pull.title, author: pull.user?.login ?? DELETED_USER_LOGIN, draft: pull.draft, updatedAt: pull.updated_at })
}
