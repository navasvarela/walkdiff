import { GitHostKind } from "@walkdiff/review-model"
import type { RepositoryRef } from "./pullRequestUrl.ts"
import { TRUSTED_GITHUB_HOSTS_VARIABLE, TRUSTED_GITLAB_HOSTS_VARIABLE, trustedHostKind } from "./trustedHosts.ts"
import type { TrustedOrigins } from "./trustedHosts.ts"

/**
 * A git remote Walkdiff can't use. The message never repeats the remote itself, which can carry a
 * token, as in `https://user:token@github.com/acme/app.git`.
 */
export class InvalidRemoteUrlError extends Error {
  override readonly name = "InvalidRemoteUrlError"
}

const REMOTE_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "ssh:", "git+ssh:"])
const SSH_PROTOCOLS: ReadonlySet<string> = new Set(["ssh:", "git+ssh:"])
// scp-like syntax, as in `git@github.com:acme/app.git`. The path can't start with `/`, which is
// what tells it apart from a URL.
const SCP_LIKE_REMOTE = /^(?:[^@/]+@)?(?<host>[^:/]+):(?<path>[^/].*)$/
const GIT_SUFFIX = /\.git$/
const GITHUB_PATH_SEGMENTS = 2
const MIN_GITLAB_PATH_SEGMENTS = 2

interface RemoteLocation {
  readonly webOrigin: string
  readonly segments: readonly string[]
}

/**
 * The repository a git remote points at, such as `git@github.com:acme/app.git` or
 * `https://gitlab.example.com/group/sub/app.git`. A remote over SSH is taken to have its web pages
 * over HTTPS on the same host name.
 *
 * # Errors
 *
 * Throws an `InvalidRemoteUrlError` when the remote can't be read, or its host isn't github.com,
 * gitlab.com or a host the user trusts, since only those can be told apart.
 */
export function parseRemoteUrl(remote: string, trusted: TrustedOrigins): RepositoryRef {
  const { webOrigin, segments } = remoteLocation(remote.trim())
  switch (trustedHostKind(webOrigin, trusted)) {
    case GitHostKind.GitHub: {
      const [owner, repo] = segments
      if (segments.length !== GITHUB_PATH_SEGMENTS || owner === undefined || repo === undefined) throw new InvalidRemoteUrlError(`A GitHub remote should end in owner/repo, at ${webOrigin}.`)
      return { host: GitHostKind.GitHub, webOrigin, owner, repo }
    }
    case GitHostKind.GitLab:
      if (segments.length < MIN_GITLAB_PATH_SEGMENTS) throw new InvalidRemoteUrlError(`A GitLab remote should end in group/project, at ${webOrigin}.`)
      return { host: GitHostKind.GitLab, webOrigin, projectPath: segments.join("/") }
    case undefined:
      throw new InvalidRemoteUrlError(`Walkdiff can't tell whether ${webOrigin} is GitHub or GitLab. If you trust it, add it to ${TRUSTED_GITHUB_HOSTS_VARIABLE} or ${TRUSTED_GITLAB_HOSTS_VARIABLE}.`)
  }
}

function remoteLocation(remote: string): RemoteLocation {
  // `github.com:acme/app` also parses as a URL, with `github.com:` as its scheme.
  const url = URL.canParse(remote) ? new URL(remote) : undefined
  if (url !== undefined && REMOTE_PROTOCOLS.has(url.protocol)) {
    return { webOrigin: SSH_PROTOCOLS.has(url.protocol) ? `https://${url.hostname}` : url.origin, segments: pathSegments(decodeURIComponent(url.pathname)) }
  }
  const scpLike = SCP_LIKE_REMOTE.exec(remote)?.groups
  if (scpLike?.host !== undefined && scpLike.path !== undefined) {
    return { webOrigin: `https://${scpLike.host.toLowerCase()}`, segments: pathSegments(scpLike.path) }
  }
  throw new InvalidRemoteUrlError("Walkdiff reads remotes over HTTPS or SSH, such as git@github.com:owner/repo.git.")
}

function pathSegments(path: string): string[] {
  return path
    .replace(GIT_SUFFIX, "")
    .split("/")
    .filter((segment) => segment !== "")
}
