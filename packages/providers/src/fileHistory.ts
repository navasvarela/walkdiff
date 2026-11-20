import { HistoryUnavailableError } from "@walkdiff/review-model"
import type { FileCommit, FileHistory, FileHistoryRequest } from "@walkdiff/review-model"
import { z } from "zod"
import { HostApiError } from "./http.ts"

/**
 * Reads changed files' recent commits from a host's API, for reviews whose local repository has
 * only the PR's own commits. Every failure becomes a `HistoryUnavailableError`, which the review
 * reports as a check it couldn't run instead of failing.
 */

// One page of commits per file is enough to judge it, and the most a host returns at once.
const COMMITS_PER_FILE = 100
// GitHub caps a query's cost; 20 histories of 100 commits each stays well inside it.
const GITHUB_PATHS_PER_QUERY = 20
const GITLAB_CONCURRENT_REQUESTS = 6

export type GraphqlRunner = <T>(query: string, variables: Readonly<Record<string, string>>, schema: z.ZodType<T>) => Promise<T>
export type JsonGetter = <T>(url: string, schema: z.ZodType<T>) => Promise<T>

const githubHistorySchema = z.object({
  totalCount: z.number(),
  nodes: z.array(
    z.object({
      oid: z.string(),
      messageHeadline: z.string(),
      committedDate: z.string(),
      author: z.object({ email: z.string().nullable(), user: z.object({ login: z.string() }).nullable() }).nullable(),
    }),
  ),
})
const githubResponseSchema = z.object({
  repository: z.object({ object: z.record(z.string(), githubHistorySchema).nullable() }).nullable(),
})

/** GitHub's GraphQL API answers for many files in one query; its REST API would need a request each. */
export async function githubFileHistory(graphql: GraphqlRunner | undefined, owner: string, name: string, request: FileHistoryRequest): Promise<Map<string, FileHistory>> {
  if (graphql === undefined) throw new HistoryUnavailableError("GitHub's API for commit history needs a token")
  const histories = new Map<string, FileHistory>()
  for (let start = 0; start < request.paths.length; start += GITHUB_PATHS_PER_QUERY) {
    const paths = request.paths.slice(start, start + GITHUB_PATHS_PER_QUERY)
    const variables: Record<string, string> = { owner, name, oid: request.until, since: request.since.toISOString() }
    paths.forEach((path, index) => {
      variables[`p${index}`] = path
    })
    const response = await asHistoryUnavailable(() => graphql(githubHistoryQuery(paths.length), variables, githubResponseSchema))
    const byAlias = response.repository?.object
    if (byAlias === null || byAlias === undefined) throw new HistoryUnavailableError("GitHub didn't find the merge base commit")
    paths.forEach((path, index) => {
      const history = byAlias[`f${index}`]
      if (history === undefined) return
      histories.set(path, {
        total: history.totalCount,
        commits: history.nodes.map((node) => ({ sha: node.oid, subject: node.messageHeadline, committedAt: node.committedDate, author: node.author?.user?.login ?? node.author?.email ?? "" })),
      })
    })
  }
  return histories
}

// Paths go in as variables, never into the query text, so a file name can't change the query.
function githubHistoryQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index)
  const parameters = indexes.map((index) => `$p${index}: String!`).join(", ")
  const fields = indexes
    .map((index) => `f${index}: history(path: $p${index}, since: $since, first: ${COMMITS_PER_FILE}) { totalCount nodes { oid messageHeadline committedDate author { email user { login } } } }`)
    .join("\n")
  return `query($owner: String!, $name: String!, $oid: GitObjectID!, $since: GitTimestamp!, ${parameters}) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { ${fields} } } }
}`
}

const gitlabCommitsSchema = z.array(z.object({ id: z.string(), title: z.string(), committed_date: z.string(), author_email: z.string().nullable().optional(), author_name: z.string().nullable().optional() }))

/** GitLab lists a file's commits one file at a time. */
export async function gitlabFileHistory(get: JsonGetter, projectApi: string, request: FileHistoryRequest): Promise<Map<string, FileHistory>> {
  const histories = new Map<string, FileHistory>()
  for (let start = 0; start < request.paths.length; start += GITLAB_CONCURRENT_REQUESTS) {
    const batch = request.paths.slice(start, start + GITLAB_CONCURRENT_REQUESTS)
    const results = await Promise.all(
      batch.map((path) => {
        const query = new URLSearchParams({ ref_name: request.until, path, since: request.since.toISOString(), per_page: String(COMMITS_PER_FILE) })
        return asHistoryUnavailable(() => get(`${projectApi}/repository/commits?${query.toString()}`, gitlabCommitsSchema))
      }),
    )
    batch.forEach((path, index) => {
      const commits: FileCommit[] = (results[index] ?? []).map((commit) => ({ sha: commit.id, subject: commit.title, committedAt: commit.committed_date, author: commit.author_email ?? commit.author_name ?? "" }))
      // GitLab's page doesn't say how many there are in all, so a full page means "at least this many".
      histories.set(path, { commits, total: commits.length })
    })
  }
  return histories
}

async function asHistoryUnavailable<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error: unknown) {
    // A refused token, a host error and an unreachable host all mean the same here: no history.
    if (error instanceof HostApiError || error instanceof TypeError || error instanceof z.ZodError) throw new HistoryUnavailableError(error.message, { cause: error })
    throw error
  }
}
