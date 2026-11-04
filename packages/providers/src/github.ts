import { commitShaSchema, GitHostKind, ReviewerState, ReviewEvent, isPlacedComment, LineSide } from "@walkdiff/review-model"
import type { CommitSha, Conversation, DiffLineRef, ReviewComment, SubmitResult, SubmitReview } from "@walkdiff/review-model"
import { z } from "zod"
import { COVERAGE_ARCHIVE_NAME, MAX_COVERAGE_ARCHIVE_BYTES, MAX_COVERAGE_ARCHIVES } from "./gitHost.ts"
import type { GitHost, GitHttpAuth, PullRequestSnapshot, CiArchive } from "./gitHost.ts"
import { downloadFile, getJson, HostApiError, writeJson } from "./http.ts"
import type { WriteMethod } from "./http.ts"
import { COMMENTS_PER_PAGE, upsertMarkedComment } from "./markedComment.ts"
import type { MarkedComment } from "./markedComment.ts"
import type { GitHubPullRequestRef } from "./pullRequestUrl.ts"

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

const issueCommentSchema = z.object({ id: z.number().int(), body: z.string().nullable() })

const compareSchema = z.object({
  merge_base_commit: z.object({ sha: commitShaSchema }),
})

const THREADS_PER_PAGE = 100
const COMMENTS_PER_THREAD = 50
const REVIEWERS_PER_PAGE = 30

const CONVERSATION_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      latestReviews(first: ${REVIEWERS_PER_PAGE}) { nodes { state author { login } } }
      reviewThreads(first: ${THREADS_PER_PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line
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
    await writeJson({ method, url, body, headers: this.#headers(), schema: z.unknown(), authHint: this.#authHint })
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

function graphqlUrl(webOrigin: string): string {
  return webOrigin === GITHUB_DOT_COM_ORIGIN ? `${GITHUB_DOT_COM_API}/graphql` : `${webOrigin}/api/graphql`
}

// GitHub Enterprise Server serves its REST API under /api/v3 on the web host.
function apiBase(webOrigin: string): string {
  return webOrigin === GITHUB_DOT_COM_ORIGIN ? GITHUB_DOT_COM_API : `${webOrigin}/api/v3`
}

// A range on GitHub is its last line plus `start_line`, both counted on the chosen side.
function githubReviewComment(comment: ReviewComment): Record<string, unknown> {
  if (comment.range === null) return { path: comment.path, line: comment.line, side: "RIGHT", body: comment.body }
  const { side, start, end } = comment.range
  const githubSide = side === LineSide.Old ? "LEFT" : "RIGHT"
  const number = (ref: DiffLineRef): number | null => (side === LineSide.Old ? ref.oldLine : ref.newLine)
  const startLine = number(start)
  const endLine = number(end)
  return { path: comment.path, line: endLine, side: githubSide, ...(startLine !== endLine ? { start_line: startLine, start_side: githubSide } : {}), body: comment.body }
}
