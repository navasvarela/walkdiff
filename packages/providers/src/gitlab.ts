import { commitShaSchema, GitHostKind, ReviewerState, ReviewEvent, isPlacedComment, lastLineOf, LineSide } from "@walkdiff/review-model"
import type { Conversation, PullRequestStack, ReviewComment, StackMember, SubmitResult, SubmitReview, DiffLineRef } from "@walkdiff/review-model"
import { z } from "zod"
import { COVERAGE_ARCHIVE_NAME, MAX_COVERAGE_ARCHIVE_BYTES, MAX_COVERAGE_ARCHIVES } from "./gitHost.ts"
import type { GitHost, GitHttpAuth, PullRequestSnapshot, CiArchive } from "./gitHost.ts"
import { downloadFile, getJson, HostApiError, writeIgnoringReply, writeJson } from "./http.ts"
import type { WriteMethod } from "./http.ts"
import { COMMENTS_PER_PAGE, upsertMarkedComment } from "./markedComment.ts"
import type { MarkedComment } from "./markedComment.ts"
import type { GitLabMergeRequestRef } from "./pullRequestUrl.ts"
import { inStackOrder, stackFromHost, walkStack } from "./stack.ts"
import type { OpenPullRequests, StackCandidate } from "./stack.ts"

// GitLab requires this username when a personal access token is used as the git password.
const GITLAB_GIT_USERNAME = "oauth2"
const AUTH_HINT = "Set GITLAB_TOKEN to a token with the read_api and read_repository scopes; posting comments needs the api scope."

const mergeRequestSchema = z.object({
  web_url: z.url(),
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  author: z.object({ username: z.string() }),
  source_branch: z.string(),
  target_branch: z.string(),
  // base_sha is the merge base, start_sha the target branch tip. Null until GitLab
  // has computed the merge request's diff, which happens shortly after it is opened.
  diff_refs: z
    .object({ base_sha: commitShaSchema, head_sha: commitShaSchema, start_sha: commitShaSchema })
    .nullable(),
})

/** A merge request as lists give it, with what stack detection needs. */
const listedMergeRequestSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  author: z.object({ username: z.string() }),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().int(),
  target_project_id: z.number().int(),
})
const projectSchema = z.object({ default_branch: z.string() })
const OPEN_STATE = "opened"
const MERGE_REQUESTS_PER_PAGE = 100

const STACK_MEMBER_FIELDS = "iid title author { username } sourceBranch targetBranch"
const STACK_QUERY = `query($project: ID!, $iid: String!) {
  project(fullPath: $project) { mergeRequest(iid: $iid) { ${STACK_MEMBER_FIELDS} stack { ${STACK_MEMBER_FIELDS} } } }
}`
const stackMemberSchema = z.object({
  // GraphQL gives the iid as a string.
  iid: z.coerce.number().int().positive(),
  title: z.string(),
  author: z.object({ username: z.string() }),
  sourceBranch: z.string(),
  targetBranch: z.string(),
})
const stackResponseSchema = z.object({
  data: z
    .object({
      project: z.object({ mergeRequest: stackMemberSchema.extend({ stack: z.array(stackMemberSchema).nullable() }).nullable() }).nullable(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string(), extensions: z.object({ code: z.string().optional() }).optional() })).optional(),
})
// What GitLab before 19.1, which has no stacks, answers when asked for the field.
const UNDEFINED_FIELD_ERROR = "undefinedField"
const GRAPHQL_FAILURE_STATUS = 502
const NOT_FOUND_STATUS = 404

/** What GitLab's own stacks say: a stack or none, or nothing to go by, which leaves following branches. */
type HostStackAnswer = { readonly usable: true; readonly stack: PullRequestStack | undefined } | { readonly usable: false }
const UNUSABLE: HostStackAnswer = { usable: false }

const noteSchema = z.object({ id: z.number().int(), body: z.string().nullable() })

const DISCUSSIONS_PER_PAGE = 100

const userSchema = z.object({ username: z.string() })

const discussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean(),
  notes: z.array(
    z.object({
      id: z.number().int(),
      body: z.string(),
      created_at: z.string(),
      system: z.boolean(),
      author: userSchema,
      resolvable: z.boolean().optional(),
      resolved: z.boolean().optional(),
      position: z
        .object({
          new_path: z.string().nullable().optional(),
          new_line: z.number().int().positive().nullable().optional(),
          old_path: z.string().nullable().optional(),
          old_line: z.number().int().positive().nullable().optional(),
        })
        .nullable()
        .optional(),
    }),
  ),
})

const approvalsSchema = z.object({ approved_by: z.array(z.object({ user: userSchema })) })
const reviewersSchema = z.array(z.object({ user: userSchema, state: z.string().nullable().optional() }))

const REVIEWER_STATES: ReadonlyMap<string, ReviewerState> = new Map([
  ["requested_changes", ReviewerState.ChangesRequested],
  ["reviewed", ReviewerState.Commented],
  ["approved", ReviewerState.Approved],
])
const REVIEWER_PUBLISH_STATES: Readonly<Record<ReviewEvent, string | undefined>> = {
  [ReviewEvent.Comment]: "reviewed",
  [ReviewEvent.Approve]: undefined,
  [ReviewEvent.RequestChanges]: "requested_changes",
}

export class DiffNotReadyError extends Error {
  override readonly name = "DiffNotReadyError"

  constructor(url: string) {
    super(`GitLab has not computed the diff for ${url} yet; try again in a moment.`)
  }
}

const pipelinesSchema = z.array(z.object({ id: z.number() }))
const pipelineJobsSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    artifacts_file: z.object({ size: z.number() }).nullish(),
    artifacts: z.array(z.object({ file_type: z.string() })).nullish(),
  }),
)
type PipelineJob = z.infer<typeof pipelineJobsSchema>[number]

/**
 * The artifact type GitLab gives a job's `reports: coverage_report`. GitLab teams usually publish
 * coverage this way from a job named `test`, so the job's name alone would miss it.
 */
const COVERAGE_REPORT_ARTIFACT_TYPE = "cobertura"

function declaresCoverageReport(job: PipelineJob): boolean {
  return job.artifacts?.some((artifact) => artifact.file_type === COVERAGE_REPORT_ARTIFACT_TYPE) === true
}

export class GitLabHost implements GitHost {
  readonly #ref: GitLabMergeRequestRef
  readonly #token: string | undefined
  readonly #authHint: string

  constructor(ref: GitLabMergeRequestRef, token: string | undefined, authHint: string = AUTH_HINT) {
    this.#ref = ref
    this.#token = token
    this.#authHint = authHint
  }

  async fetchPullRequest(): Promise<PullRequestSnapshot> {
    const { webOrigin, projectPath } = this.#ref
    const url = this.#mergeRequestApi()
    const mergeRequest = await getJson({ url, headers: this.#headers(), schema: mergeRequestSchema, authHint: this.#authHint })
    if (mergeRequest.diff_refs === null) {
      throw new DiffNotReadyError(mergeRequest.web_url)
    }

    return {
      pullRequest: {
        host: GitHostKind.GitLab,
        url: mergeRequest.web_url,
        repositoryWebUrl: `${webOrigin}/${projectPath}`,
        number: mergeRequest.iid,
        title: mergeRequest.title,
        description: mergeRequest.description ?? "",
        author: mergeRequest.author.username,
        baseRef: mergeRequest.target_branch,
        headRef: mergeRequest.source_branch,
        baseSha: mergeRequest.diff_refs.start_sha,
        headSha: mergeRequest.diff_refs.head_sha,
        mergeBaseSha: mergeRequest.diff_refs.base_sha,
      },
      cloneUrl: `${webOrigin}/${projectPath}.git`,
      gitAuth: this.#gitAuth(),
    }
  }

  upsertComment(comment: MarkedComment): Promise<void> {
    const notesUrl = `${this.#mergeRequestApi()}/notes`
    return upsertMarkedComment(
      {
        listPage: (page) =>
          getJson({
            url: `${notesUrl}?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
            headers: this.#headers(),
            schema: z.array(noteSchema),
            authHint: this.#authHint,
          }),
        create: (body) => this.#write("POST", notesUrl, { body }),
        update: (id, body) => this.#write("PUT", `${notesUrl}/${id}`, { body }),
      },
      comment,
    )
  }

  async fetchConversation(): Promise<Conversation> {
    const api = this.#mergeRequestApi()
    const [discussions, approvals, reviewers] = await Promise.all([
      this.#get(`${api}/discussions?per_page=${DISCUSSIONS_PER_PAGE}`, z.array(discussionSchema)),
      this.#get(`${api}/approvals`, approvalsSchema),
      this.#get(`${api}/reviewers`, reviewersSchema),
    ])
    const approved = new Set(approvals.approved_by.map(({ user }) => user.username))
    const others = reviewers.filter(({ user }) => !approved.has(user.username)).map(({ user, state }) => ({ name: user.username, state: REVIEWER_STATES.get(state ?? "") ?? ReviewerState.Other }))
    return {
      reviewers: [...[...approved].map((name) => ({ name, state: ReviewerState.Approved })), ...others],
      threads: discussions.filter((discussion) => !discussion.individual_note).map((discussion) => this.#toThread(discussion)),
      truncated: discussions.length === DISCUSSIONS_PER_PAGE,
    }
  }

  /**
   * GitLab has no single call for this, so comments are drafted and then published together.
   * Drafts are invisible until then, so a failure part-way leaves nothing others can see, though
   * the drafts stay on the merge request. Approval is a separate call, made last so that a review
   * can't be approved if its comments failed.
   */
  async submitReview(review: SubmitReview): Promise<SubmitResult> {
    const api = this.#mergeRequestApi()
    const mergeRequest = await this.#get(api, mergeRequestSchema)
    const refs = mergeRequest.diff_refs
    if (refs === null) throw new DiffNotReadyError(mergeRequest.web_url)
    for (const comment of review.comments.filter(isPlacedComment)) {
      const last = lastLineOf(comment)
      await this.#write("POST", `${api}/draft_notes`, {
        note: gitlabNote(comment),
        position: {
          position_type: "text",
          base_sha: refs.base_sha,
          start_sha: refs.start_sha,
          head_sha: refs.head_sha,
          old_path: comment.previousPath,
          new_path: comment.path,
          // An unchanged line needs both numbers, or GitLab rejects the position.
          ...(last?.oldLine == null ? {} : { old_line: last.oldLine }),
          ...(last?.newLine == null ? {} : { new_line: last.newLine }),
        },
      })
    }
    const text = withUnplacedComments(review)
    if (text !== "") await this.#write("POST", `${api}/draft_notes`, { note: text })
    const reviewerState = REVIEWER_PUBLISH_STATES[review.event]
    await this.#write("POST", `${api}/draft_notes/bulk_publish`, reviewerState === undefined ? {} : { reviewer_state: reviewerState })
    if (review.event === ReviewEvent.Approve) await this.#write("POST", `${api}/approve`, { sha: review.headSha })
    return { url: mergeRequest.web_url }
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.#write("POST", `${this.#mergeRequestApi()}/discussions/${encodeURIComponent(threadId)}/notes`, { body })
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    await this.#write("PUT", `${this.#mergeRequestApi()}/discussions/${encodeURIComponent(threadId)}`, { resolved })
  }

  #toThread(discussion: z.infer<typeof discussionSchema>): Conversation["threads"][number] {
    const { webOrigin, projectPath, number } = this.#ref
    const notes = discussion.notes.filter((note) => !note.system)
    const position = notes.at(0)?.position
    return {
      id: discussion.id,
      // GitLab leaves out `new_line` on a removed line, and gives only `old_line`.
      path: position?.new_path ?? position?.old_path ?? null,
      line: position?.new_line ?? position?.old_line ?? null,
      side: position?.new_line == null && position?.old_line != null ? LineSide.Old : LineSide.New,
      isResolved: notes.some((note) => note.resolvable === true) && notes.filter((note) => note.resolvable === true).every((note) => note.resolved === true),
      isOutdated: false,
      comments: notes.map((note) => ({ author: note.author.username, body: note.body, createdAt: note.created_at, url: `${webOrigin}/${projectPath}/-/merge_requests/${number}#note_${note.id}` })),
    }
  }

  /**
   * GitLab's own stacks are found from branches, as Walkdiff would, but only between merge requests
   * by the same author, so its answer wins where there is one. Instances older than 19.1 have none.
   */
  async fetchStack(): Promise<PullRequestStack | undefined> {
    const answer = await this.#hostStack()
    return answer.usable ? answer.stack : this.#walkStack()
  }

  async #hostStack(): Promise<HostStackAnswer> {
    const url = `${this.#ref.webOrigin}/api/graphql`
    const response = await writeJson({
      method: "POST",
      url,
      body: { query: STACK_QUERY, variables: { project: this.#ref.projectPath, iid: String(this.#ref.number) } },
      headers: this.#headers(),
      schema: stackResponseSchema,
      authHint: this.#authHint,
    })
    const errors = response.errors ?? []
    if (errors.some((error) => error.extensions?.code === UNDEFINED_FIELD_ERROR)) return UNUSABLE
    // GraphQL reports most failures with a 200, so they would otherwise look like success.
    if (errors.length > 0) throw new HostApiError(GRAPHQL_FAILURE_STATUS, url, errors.map((error) => error.message).join("; "))
    const mergeRequest = response.data?.project?.mergeRequest
    if (mergeRequest == null) throw new HostApiError(NOT_FOUND_STATUS, url, this.#authHint)
    // Null when the stack is longer than GitLab shows; following branches still finds part of it.
    if (mergeRequest.stack === null) return UNUSABLE
    if (mergeRequest.stack.length === 0) return { usable: true, stack: undefined }
    const ordered = inStackOrder([mergeRequest, ...mergeRequest.stack].map(fromGraphql))
    return ordered === undefined ? UNUSABLE : { usable: true, stack: stackFromHost(ordered, this.#ref.number) }
  }

  async #walkStack(): Promise<PullRequestStack | undefined> {
    const projectApi = this.#projectApi()
    const [mergeRequest, project] = await Promise.all([this.#get(this.#mergeRequestApi(), listedMergeRequestSchema), this.#get(projectApi, projectSchema)])
    return walkStack({ pullRequest: stackCandidate(mergeRequest), defaultBranch: project.default_branch }, this.#openMergeRequests(projectApi))
  }

  #openMergeRequests(projectApi: string): OpenPullRequests {
    const list = async (filter: string): Promise<readonly StackCandidate[]> =>
      (await this.#get(`${projectApi}/merge_requests?state=${OPEN_STATE}&per_page=${MERGE_REQUESTS_PER_PAGE}&${filter}`, z.array(listedMergeRequestSchema))).map(stackCandidate)
    return {
      withHead: (branch) => list(`source_branch=${encodeURIComponent(branch)}`),
      withBase: (branch) => list(`target_branch=${encodeURIComponent(branch)}`),
    }
  }

  #get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    return getJson({ url, headers: this.#headers(), schema, authHint: this.#authHint })
  }

  async fetchCoverageArchives(headSha: string): Promise<readonly CiArchive[]> {
    const projectApi = this.#projectApi()
    const [pipeline] = await this.#get(`${projectApi}/pipelines?sha=${encodeURIComponent(headSha)}&per_page=1`, pipelinesSchema)
    if (pipeline === undefined) return []
    const jobs = await this.#get(`${projectApi}/pipelines/${pipeline.id}/jobs?per_page=100`, pipelineJobsSchema)
    // Jobs that declare a coverage report come first: they're the surest to hold one.
    const declared = jobs.filter(declaresCoverageReport)
    const named = jobs.filter((job) => !declaresCoverageReport(job) && COVERAGE_ARCHIVE_NAME.test(job.name))
    const wanted = [...declared, ...named]
      .filter((job) => job.artifacts_file != null && job.artifacts_file.size <= MAX_COVERAGE_ARCHIVE_BYTES)
      .slice(0, MAX_COVERAGE_ARCHIVES)
    const downloaded = await Promise.all(
      wanted.map(async (job) => ({
        name: job.name,
        zip: await downloadFile({ url: `${projectApi}/jobs/${job.id}/artifacts`, headers: this.#headers(), maxBytes: MAX_COVERAGE_ARCHIVE_BYTES, authHint: this.#authHint }),
      })),
    )
    return downloaded.flatMap(({ name, zip }) => (zip === undefined ? [] : [{ name, zip }]))
  }

  #projectApi(): string {
    const { webOrigin, projectPath } = this.#ref
    return `${webOrigin}/api/v4/projects/${encodeURIComponent(projectPath)}`
  }

  #mergeRequestApi(): string {
    return `${this.#projectApi()}/merge_requests/${this.#ref.number}`
  }

  async #write(method: WriteMethod, url: string, body: unknown): Promise<void> {
    await writeIgnoringReply({ method, url, body, headers: this.#headers(), authHint: this.#authHint })
  }

  #headers(): Record<string, string> {
    return this.#token === undefined ? {} : { "PRIVATE-TOKEN": this.#token }
  }

  #gitAuth(): GitHttpAuth | undefined {
    return this.#token === undefined ? undefined : { username: GITLAB_GIT_USERNAME, token: this.#token }
  }
}

function stackCandidate(mergeRequest: z.infer<typeof listedMergeRequestSchema>): StackCandidate {
  return {
    member: { number: mergeRequest.iid, title: mergeRequest.title, author: mergeRequest.author.username, headRef: mergeRequest.source_branch, baseRef: mergeRequest.target_branch },
    headInRepository: mergeRequest.source_project_id === mergeRequest.target_project_id,
  }
}

function fromGraphql(mergeRequest: z.infer<typeof stackMemberSchema>): StackMember {
  return { number: mergeRequest.iid, title: mergeRequest.title, author: mergeRequest.author.username, headRef: mergeRequest.sourceBranch, baseRef: mergeRequest.targetBranch }
}

/** Comments without a line, and the summary, go together as one note. */
function withUnplacedComments(review: SubmitReview): string {
  const unplaced = review.comments.filter((comment: ReviewComment) => !isPlacedComment(comment)).map((comment) => `**\`${comment.label}\`** in \`${comment.path}\`\n\n${comment.body}`)
  return [review.body, ...unplaced].filter((part) => part !== "").join("\n\n---\n\n")
}

/**
 * GitLab's multi-line position needs line codes this can't check without a real instance, so a range
 * sits on its last line and says which lines it covers.
 */
function gitlabNote(comment: ReviewComment): string {
  const range = comment.range
  if (range === null) return comment.body
  const number = (ref: DiffLineRef): number | null => (range.side === LineSide.Old ? ref.oldLine : ref.newLine)
  const first = number(range.start)
  const last = number(range.end)
  return first === last ? comment.body : `Lines ${first}–${last}${range.side === LineSide.Old ? " (before)" : ""}:\n\n${comment.body}`
}
