import type { PullRequestListing } from "@walkdiff/review-model"
import { z } from "zod"
import { gitlabApiBase, gitlabHeaders, gitlabProjectApi } from "./gitlab.ts"
import { getJson } from "./http.ts"
import { listingFrom, MAX_REVIEW_REQUESTS, NotSignedInError } from "./pullRequestDirectory.ts"
import type { PullRequestDirectory } from "./pullRequestDirectory.ts"
import type { GitLabProjectRef } from "./pullRequestUrl.ts"

const AUTH_HINT = "Set GITLAB_TOKEN to a token with the read_api scope."
const OPEN_STATE = "opened"
const MERGE_REQUESTS_PER_PAGE = 100

const listedSchema = z.object({
  web_url: z.url(),
  title: z.string(),
  author: z.object({ username: z.string() }),
  draft: z.boolean().default(false),
  updated_at: z.string(),
  source_project_id: z.number().int(),
  target_project_id: z.number().int(),
})
type Listed = z.infer<typeof listedSchema>

const userSchema = z.object({ username: z.string() })

export class GitLabDirectory implements PullRequestDirectory {
  readonly #project: GitLabProjectRef
  readonly #token: string | undefined

  constructor(project: GitLabProjectRef, token: string | undefined) {
    this.#project = project
    this.#token = token
  }

  async openFromBranch(branch: string): Promise<readonly PullRequestListing[]> {
    const url = `${gitlabProjectApi(this.#project)}/merge_requests?state=${OPEN_STATE}&source_branch=${encodeURIComponent(branch)}&per_page=${MERGE_REQUESTS_PER_PAGE}`
    const listed = await this.#get(url, z.array(listedSchema))
    // A fork's branch of the same name would match too; only this project's own branch is wanted.
    return listed.filter((mergeRequest) => mergeRequest.source_project_id === mergeRequest.target_project_id).map(toListing)
  }

  /**
   * GitLab keeps a reviewer on a merge request after they review it, so unlike GitHub this also
   * lists merge requests the user has already reviewed and that are still open.
   */
  async awaitingMyReview(): Promise<readonly PullRequestListing[]> {
    if (this.#token === undefined) throw new NotSignedInError(`Walkdiff needs your GitLab login to find merge requests waiting for your review. ${AUTH_HINT}`)
    const api = gitlabApiBase(this.#project.webOrigin)
    const { username } = await this.#get(`${api}/user`, userSchema)
    // `scope=all`, as the default scope is only merge requests the user opened.
    const url = `${api}/merge_requests?state=${OPEN_STATE}&scope=all&reviewer_username=${encodeURIComponent(username)}&order_by=updated_at&sort=desc&per_page=${MAX_REVIEW_REQUESTS}`
    return (await this.#get(url, z.array(listedSchema))).map(toListing)
  }

  #get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    return getJson({ url, headers: gitlabHeaders(this.#token), schema, authHint: AUTH_HINT })
  }
}

function toListing(mergeRequest: Listed): PullRequestListing {
  return listingFrom({ url: mergeRequest.web_url, title: mergeRequest.title, author: mergeRequest.author.username, draft: mergeRequest.draft, updatedAt: mergeRequest.updated_at })
}
