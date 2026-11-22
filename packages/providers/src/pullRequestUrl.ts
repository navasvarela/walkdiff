import { GitHostKind } from "@walkdiff/review-model"

export interface GitHubRepositoryRef {
  readonly host: typeof GitHostKind.GitHub
  readonly webOrigin: string
  readonly owner: string
  readonly repo: string
}

export interface GitHubPullRequestRef extends GitHubRepositoryRef {
  readonly number: number
}

export interface GitLabProjectRef {
  readonly host: typeof GitHostKind.GitLab
  readonly webOrigin: string
  /** Full namespace path; GitLab allows nested groups, e.g. `group/subgroup/project`. */
  readonly projectPath: string
}

export interface GitLabMergeRequestRef extends GitLabProjectRef {
  /** The merge request's project-scoped number (GitLab's `iid`), as shown in its URL. */
  readonly number: number
}

export type RepositoryRef = GitHubRepositoryRef | GitLabProjectRef
export type PullRequestRef = GitHubPullRequestRef | GitLabMergeRequestRef

export class InvalidPullRequestUrlError extends Error {
  override readonly name = "InvalidPullRequestUrlError"

  constructor(input: string, reason: string) {
    super(`Not a pull request URL (${reason}): ${input}`)
  }
}

// Hosts are recognised by path shape rather than hostname so that GitHub Enterprise
// and self-managed GitLab instances work without configuration.
const GITHUB_PULL_PATH = /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>\d+)(?:\/.*)?$/
const GITLAB_MERGE_REQUEST_PATH = /^\/(?<project>.+?)\/-\/merge_requests\/(?<number>\d+)(?:\/.*)?$/

export function parsePullRequestUrl(input: string): PullRequestRef {
  const url = parseHttpUrl(input)

  const github = GITHUB_PULL_PATH.exec(url.pathname)?.groups
  if (github?.owner && github.repo && github.number) {
    return {
      host: GitHostKind.GitHub,
      webOrigin: url.origin,
      owner: github.owner,
      repo: github.repo,
      number: parsePositiveInteger(github.number, input),
    }
  }

  const gitlab = GITLAB_MERGE_REQUEST_PATH.exec(url.pathname)?.groups
  if (gitlab?.project && gitlab.number) {
    return {
      host: GitHostKind.GitLab,
      webOrigin: url.origin,
      projectPath: gitlab.project,
      number: parsePositiveInteger(gitlab.number, input),
    }
  }

  throw new InvalidPullRequestUrlError(
    input,
    "expected …/owner/repo/pull/N or …/group/project/-/merge_requests/N",
  )
}

function parseHttpUrl(input: string): URL {
  if (!URL.canParse(input)) {
    throw new InvalidPullRequestUrlError(input, "not a valid URL")
  }
  const url = new URL(input)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidPullRequestUrlError(input, "only http and https URLs are supported")
  }
  return url
}

function parsePositiveInteger(digits: string, input: string): number {
  const value = Number(digits)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidPullRequestUrlError(input, "the pull request number is out of range")
  }
  return value
}

/** The repository's path on its host, e.g. `owner/repo` or `group/subgroup/project`. */
export function repositoryPath(ref: RepositoryRef): string {
  return ref.host === GitHostKind.GitHub ? `${ref.owner}/${ref.repo}` : ref.projectPath
}

/** The short name each host uses in its own UI: `owner/repo#12` or `group/project!12`. */
export function displayName(ref: PullRequestRef): string {
  const separator = ref.host === GitHostKind.GitHub ? "#" : "!"
  return `${repositoryPath(ref)}${separator}${ref.number}`
}
