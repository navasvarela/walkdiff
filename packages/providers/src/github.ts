import { commitShaSchema, GitHostKind, PullRequestState, ReviewerState, ReviewEvent, isPlacedComment, LineSide } from "@walkdiff/review-model"
import type { CommitSha, Conversation, DiffLineRef, PullRequestStack, PullRequestStatus, ReviewComment, SubmitResult, SubmitReview } from "@walkdiff/review-model"
import { z } from "zod"
import { COVERAGE_ARCHIVE_NAME, MAX_COVERAGE_ARCHIVE_BYTES, MAX_COVERAGE_ARCHIVES } from "./gitHost.ts"
import type { GitHost, GitHttpAuth, PullRequestSnapshot, CiArchive } from "./gitHost.ts"
import { downloadFile, getJson, HostApiError, writeIgnoringReply, writeJson } from "./http.ts"
import type { WriteMethod } from "./http.ts"
import { COMMENTS_PER_PAGE, upsertMarkedComment } from "./markedComment.ts"
import type { MarkedComment } from "./markedComment.ts"
import type { GitHubPullRequestRef } from "./pullRequestUrl.ts"
import { keptAround, stackFromHost, walkStack } from "./stack.ts"
import type { OpenPullRequests, StackCandidate } from "./stack.ts"

const GITHUB_DOT_COM_ORIGIN = "https://github.com"
const GITHUB_DOT_COM_API = "https://api.github.com"
const GITHUB_API_VERSION = "2022-11-28"
// GitHub accepts any username with a token over HTTPS; this is the one its docs use.
const GITHUB_GIT_USERNAME = "x-access-token"
const USER_AGENT = "walkdiff-review"
const AUTH_HINT = "Set GITHUB_TOKEN (or GH_TOKEN) to a token that can read this repository; posting comments also needs pull-requests: write."
const DELETED_USER_LOGIN = "ghost"

const branchTipSchema = z.object({ ref: z.string(), sha: commitShaSchema })

const pullSchema = z.object({
  html_url: z.url(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  // GitHub returns null for accounts that have since been deleted.
  user: z.object({ login: z.string() }).nullable(),
  base: branchTipSchema,
  head: branchTipSchema,
})

const pullStatusSchema = z.object({
  state: z.string(),
  merged_at: z.string().nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ sha: commitShaSchema }),
})

const repositorySchema = z.object({ full_name: z.string() })

/** A PR as lists give it, with what stack detection needs. */
const listedPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ ref: z.string(), repo: repositorySchema }),
  // Null when the fork it came from has been deleted.
  head: z.object({ ref: z.string(), repo: repositorySchema.nullable() }),
})
type ListedPull = z.infer<typeof listedPullSchema>

const stackedPullSchema = listedPullSchema.extend({
  base: z.object({ ref: z.string(), repo: repositorySchema.extend({ default_branch: z.string() }) }),
  // GitHub Enterprise Server has no stacks yet, and leaves the field out.
  stack: z.object({ number: z.number().int().positive() }).nullish(),
})

const stackSchema = z.object({
  /** Bottom first, merged and closed ones included. */
  pull_requests: z.array(z.object({ number: z.number().int().positive(), state: z.string(), merged_at: z.string().nullable() })),
})
const OPEN_STATE = "open"
const PULLS_PER_PAGE = 100

const issueCommentSchema = z.object({ id: z.number().int(), body: z.string().nullable() })

const compareSchema = z.object({
  merge_base_commit: z.object({ sha: commitShaSchema }),
})

const THREADS_PER_PAGE = 100
// GitHub's names for the two sides of a diff: the base version and the head version.
const GITHUB_LEFT = "LEFT"
const GITHUB_RIGHT = "RIGHT"
const COMMENTS_PER_THREAD = 50
const REVIEWERS_PER_PAGE = 30

const CONVERSATION_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      latestReviews(first: ${REVIEWERS_PER_PAGE}) { nodes { state author { login } } }
      reviewThreads(first: ${THREADS_PER_PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line diffSide
          comments(first: ${COMMENTS_PER_THREAD}) { nodes { bodyText createdAt url author { login } } }
        }
      }
    }
  }
}`
const REPLY_MUTATION = "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }"
const RESOLVE_MUTATION = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }"
const UNRESOLVE_MUTATION = "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }"

const authorSchema = z.object({ login: z.string() }).nullable()

const conversationResponseSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      latestReviews: z.object({ nodes: z.array(z.object({ state: z.string(), author: authorSchema })) }),
      reviewThreads: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(
          z.object({
            id: z.string(),
            isResolved: z.boolean(),
            isOutdated: z.boolean(),
            path: z.string(),
            line: z.number().int().positive().nullable(),
            diffSide: z.enum([GITHUB_LEFT, GITHUB_RIGHT]),
            comments: z.object({ nodes: z.array(z.object({ bodyText: z.string(), createdAt: z.string(), url: z.string(), author: authorSchema })) }),
          }),
        ),
      }),
    }),
  }),
})

const REVIEW_EVENTS: Readonly<Record<ReviewEvent, string>> = {
  [ReviewEvent.Comment]: "COMMENT",
  [ReviewEvent.Approve]: "APPROVE",
  [ReviewEvent.RequestChanges]: "REQUEST_CHANGES",
}

const REVIEWER_STATES: ReadonlyMap<string, ReviewerState> = new Map([
  ["APPROVED", ReviewerState.Approved],
  ["CHANGES_REQUESTED", ReviewerState.ChangesRequested],
  ["COMMENTED", ReviewerState.Commented],
])

// A commit rarely has more; reruns and unrelated workflows make up most of these.
const MAX_WORKFLOW_RUNS = 20

const workflowRunsSchema = z.object({ workflow_runs: z.array(z.object({ id: z.number() })) })
const runArtifactsSchema = z.object({
  artifacts: z.array(z.object({ id: z.number(), name: z.string(), expired: z.boolean(), size_in_bytes: z.number() })),
})

export class GitHubHost implements GitHost {
  readonly #ref: GitHubPullRequestRef
  readonly #token: string | undefined
  readonly #authHint: string

  constructor(ref: GitHubPullRequestRef, token: string | undefined, authHint: string = AUTH_HINT) {
    this.#ref = ref
    this.#token = token
    this.#authHint = authHint
  }

  async fetchPullRequest(): Promise<PullRequestSnapshot> {
    const { owner, repo, number, webOrigin } = this.#ref
    const repoApi = this.#repoApi()
    const pull = await this.#get(`${repoApi}/pulls/${number}`, pullSchema)
    const mergeBaseSha = await this.#mergeBase(repoApi, pull.base.sha, pull.head.sha)

    return {
      pullRequest: {
        host: GitHostKind.GitHub,
        url: pull.html_url,
        repositoryWebUrl: `${webOrigin}/${owner}/${repo}`,
        number: pull.number,
        title: pull.title,
        description: pull.body ?? "",
        author: pull.user?.login ?? DELETED_USER_LOGIN,
        baseRef: pull.base.ref,
        headRef: pull.head.ref,
        baseSha: pull.base.sha,
        headSha: pull.head.sha,
        mergeBaseSha,
      },
      cloneUrl: `${webOrigin}/${owner}/${repo}.git`,
      gitAuth: this.#gitAuth(),
    }
  }

  async fetchStatus(): Promise<PullRequestStatus> {
    const pull = await this.#get(`${this.#repoApi()}/pulls/${this.#ref.number}`, pullStatusSchema)
    return { state: githubState(pull), headSha: pull.head.sha, baseRef: pull.base.ref }
  }

  upsertComment(comment: MarkedComment): Promise<void> {
    const repoApi = this.#repoApi()
    const commentsUrl = `${repoApi}/issues/${this.#ref.number}/comments`
    return upsertMarkedComment(
      {
        listPage: (page) => this.#get(`${commentsUrl}?per_page=${COMMENTS_PER_PAGE}&page=${page}`, z.array(issueCommentSchema)),
        create: (body) => this.#write("POST", commentsUrl, { body }),
        update: (id, body) => this.#write("PATCH", `${repoApi}/issues/comments/${id}`, { body }),
      },
      comment,
    )
  }

  async fetchConversation(): Promise<Conversation> {
    const { owner, repo, number } = this.#ref
    const data = await this.#graphql(CONVERSATION_QUERY, { owner, repo, number }, conversationResponseSchema)
    const { latestReviews, reviewThreads } = data.repository.pullRequest
    return {
      reviewers: latestReviews.nodes.map((review) => ({ name: review.author?.login ?? DELETED_USER_LOGIN, state: REVIEWER_STATES.get(review.state) ?? ReviewerState.Other })),
      threads: reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        side: thread.diffSide === GITHUB_LEFT ? LineSide.Old : LineSide.New,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        comments: thread.comments.nodes.map((comment) => ({ author: comment.author?.login ?? DELETED_USER_LOGIN, body: comment.bodyText, createdAt: comment.createdAt, url: comment.url })),
      })),
      truncated: reviewThreads.pageInfo.hasNextPage,
    }
  }

  async submitReview(review: SubmitReview): Promise<SubmitResult> {
    const onLines = review.comments.filter(isPlacedComment)
    const posted = await writeJson({
      method: "POST",
      url: `${this.#repoApi()}/pulls/${this.#ref.number}/reviews`,
      headers: this.#headers(),
      schema: postedReviewSchema,
      authHint: this.#authHint,
      body: {
        // Ties the review to the commit that was read, so it can't land on a newer one.
        commit_id: review.headSha,
        event: REVIEW_EVENTS[review.event],
        body: withUnplacedComments(review),
        comments: onLines.map(githubReviewComment),
      },
    })
    return { url: posted.html_url }
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.#graphql(REPLY_MUTATION, { id: threadId, body }, z.unknown())
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    await this.#graphql(resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { id: threadId }, z.unknown())
  }

  async fetchCoverageArchives(headSha: string): Promise<readonly CiArchive[]> {
    const repoApi = this.#repoApi()
    const { workflow_runs: runs } = await this.#get(`${repoApi}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=${MAX_WORKFLOW_RUNS}`, workflowRunsSchema)
    const listed = await Promise.all(runs.map((run) => this.#get(`${repoApi}/actions/runs/${run.id}/artifacts?per_page=100`, runArtifactsSchema)))
    const wanted = listed
      .flatMap((list) => list.artifacts)
      .filter((artifact) => !artifact.expired && COVERAGE_ARCHIVE_NAME.test(artifact.name) && artifact.size_in_bytes <= MAX_COVERAGE_ARCHIVE_BYTES)
      .slice(0, MAX_COVERAGE_ARCHIVES)
    const downloaded = await Promise.all(
      wanted.map(async (artifact) => ({
        name: artifact.name,
        zip: await downloadFile({ url: `${repoApi}/actions/artifacts/${artifact.id}/zip`, headers: this.#headers(), maxBytes: MAX_COVERAGE_ARCHIVE_BYTES, authHint: this.#authHint }),
      })),
    )
    return downloaded.flatMap(({ name, zip }) => (zip === undefined ? [] : [{ name, zip }]))
  }

  /**
   * A stack made with GitHub's own stacks comes from the host. Many teams stack with other tools,
   * so a PR outside one is still checked by following branches.
   */
  async fetchStack(): Promise<PullRequestStack | undefined> {
    const repoApi = this.#repoApi()
    const pull = await this.#get(`${repoApi}/pulls/${this.#ref.number}`, stackedPullSchema)
    if (pull.stack != null) return this.#hostStack(repoApi, pull.stack.number)
    return walkStack({ pullRequest: stackCandidate(pull), defaultBranch: pull.base.repo.default_branch }, this.#openPullRequests(repoApi))
  }

  async #hostStack(repoApi: string, stackNumber: number): Promise<PullRequestStack | undefined> {
    const stack = await this.#get(`${repoApi}/stacks/${stackNumber}`, stackSchema)
    const open = stack.pull_requests.filter((pull) => pull.state === OPEN_STATE && pull.merged_at === null).map((pull) => pull.number)
    // Only the members kept are read, so a long stack costs no more requests than the limit.
    const kept = keptAround(open, open.indexOf(this.#ref.number))
    const pulls = await Promise.all(kept.map((number) => this.#get(`${repoApi}/pulls/${number}`, listedPullSchema)))
    return stackFromHost(pulls.map((pull) => stackCandidate(pull).member), this.#ref.number)
  }

  #openPullRequests(repoApi: string): OpenPullRequests {
    const list = async (filter: string): Promise<readonly StackCandidate[]> =>
      (await this.#get(`${repoApi}/pulls?state=${OPEN_STATE}&per_page=${PULLS_PER_PAGE}&${filter}`, z.array(listedPullSchema))).map(stackCandidate)
    return {
      // GitHub names a head branch by its repository's owner, as `owner:branch`.
      withHead: (branch) => list(`head=${encodeURIComponent(`${this.#ref.owner}:${branch}`)}`),
      withBase: (branch) => list(`base=${encodeURIComponent(branch)}`),
    }
  }

  async #graphql<T>(query: string, variables: Readonly<Record<string, string | number>>, schema: z.ZodType<T>): Promise<T> {
    const url = graphqlUrl(this.#ref.webOrigin)
    const response = await writeJson({ method: "POST", url, body: { query, variables }, headers: this.#headers(), schema: graphqlResponseSchema, authHint: this.#authHint })
    // GraphQL reports most failures with a 200, so they would otherwise look like success.
    if (response.errors !== undefined && response.errors.length > 0) throw new HostApiError(GRAPHQL_FAILURE_STATUS, url, response.errors.map((error) => error.message).join("; "))
    return schema.parse(response.data)
  }

  #repoApi(): string {
    const { owner, repo, webOrigin } = this.#ref
    return `${apiBase(webOrigin)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  }

  async #mergeBase(repoApi: string, base: CommitSha, head: CommitSha): Promise<CommitSha> {
    const comparison = await this.#get(`${repoApi}/compare/${base}...${head}`, compareSchema)
    return comparison.merge_base_commit.sha
  }

  #get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    return getJson({ url, headers: this.#headers(), schema, authHint: this.#authHint })
  }

  async #write(method: WriteMethod, url: string, body: unknown): Promise<void> {
    await writeIgnoringReply({ method, url, body, headers: this.#headers(), authHint: this.#authHint })
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
    }
    if (this.#token !== undefined) {
      headers.Authorization = `Bearer ${this.#token}`
    }
    return headers
  }

  #gitAuth(): GitHttpAuth | undefined {
    return this.#token === undefined ? undefined : { username: GITHUB_GIT_USERNAME, token: this.#token }
  }
}

const postedReviewSchema = z.object({ html_url: z.string() })
const graphqlResponseSchema = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() })
const GRAPHQL_FAILURE_STATUS = 502

/** GitHub only accepts comments on lines, so anything without one joins the review's own text. */
function withUnplacedComments(review: SubmitReview): string {
  const unplaced = review.comments.filter((comment: ReviewComment) => !isPlacedComment(comment)).map((comment) => `**\`${comment.label}\`** in \`${comment.path}\`\n\n${comment.body}`)
  return [review.body, ...unplaced].filter((part) => part !== "").join("\n\n---\n\n")
}

/** GitHub calls a merged PR closed, telling them apart only by `merged_at`. */
function githubState(pull: z.infer<typeof pullStatusSchema>): PullRequestState {
  if (pull.merged_at !== null) return PullRequestState.Merged
  return pull.state === OPEN_STATE ? PullRequestState.Open : PullRequestState.Closed
}

function stackCandidate(pull: ListedPull): StackCandidate {
  return {
    member: { number: pull.number, title: pull.title, author: pull.user?.login ?? DELETED_USER_LOGIN, headRef: pull.head.ref, baseRef: pull.base.ref },
    // GitHub matches repository names without regard to case.
    headInRepository: pull.head.repo?.full_name.toLowerCase() === pull.base.repo.full_name.toLowerCase(),
  }
}

function graphqlUrl(webOrigin: string): string {
  return webOrigin === GITHUB_DOT_COM_ORIGIN ? `${GITHUB_DOT_COM_API}/graphql` : `${webOrigin}/api/graphql`
}

// GitHub Enterprise Server serves its REST API under /api/v3 on the web host.
function apiBase(webOrigin: string): string {
  return webOrigin === GITHUB_DOT_COM_ORIGIN ? GITHUB_DOT_COM_API : `${webOrigin}/api/v3`
}

// A range on GitHub is its last line plus `start_line`, both counted on the chosen side.
function githubReviewComment(comment: ReviewComment): Record<string, unknown> {
  if (comment.range === null) return { path: comment.path, line: comment.line, side: GITHUB_RIGHT, body: comment.body }
  const { side, start, end } = comment.range
  const githubSide = side === LineSide.Old ? GITHUB_LEFT : GITHUB_RIGHT
  const number = (ref: DiffLineRef): number | null => (side === LineSide.Old ? ref.oldLine : ref.newLine)
  const startLine = number(start)
  const endLine = number(end)
  return { path: comment.path, line: endLine, side: githubSide, ...(startLine !== endLine ? { start_line: startLine, start_side: githubSide } : {}), body: comment.body }
}
