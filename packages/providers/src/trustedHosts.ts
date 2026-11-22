import { GitHostKind } from "@walkdiff/review-model"
import type { RepositoryRef } from "./pullRequestUrl.ts"

/** Hosts beyond github.com and gitlab.com that may receive each kind of token, as URL origins. */
export interface TrustedOrigins {
  readonly github: readonly string[]
  readonly gitlab: readonly string[]
}

export const TRUSTED_GITHUB_HOSTS_VARIABLE = "WALKDIFF_TRUSTED_GITHUB_HOSTS"
export const TRUSTED_GITLAB_HOSTS_VARIABLE = "WALKDIFF_TRUSTED_GITLAB_HOSTS"

const GITHUB_DOT_COM_ORIGIN = "https://github.com"
const GITLAB_DOT_COM_ORIGIN = "https://gitlab.com"

/**
 * Whether this link's host may receive the token for its kind of host. Links are pasted by
 * hand and their kind is read from the path, so neither the host name nor the kind can be
 * taken on trust: `https://evil.example/a/b/pull/1` would otherwise receive a GitHub token,
 * and `https://gitlab.com/a/b/pull/1` would receive a GitHub token at GitLab. Comparing
 * whole origins also keeps a token off plain http and off look-alikes such as
 * `github.com.evil.example`.
 */
export function isTrustedHost(ref: RepositoryRef, trusted: TrustedOrigins): boolean {
  return ref.host === GitHostKind.GitHub
    ? ref.webOrigin === GITHUB_DOT_COM_ORIGIN || trusted.github.includes(ref.webOrigin)
    : ref.webOrigin === GITLAB_DOT_COM_ORIGIN || trusted.gitlab.includes(ref.webOrigin)
}

/**
 * The kind of host at a trusted origin, or undefined for any other origin. A git remote's URL
 * doesn't show the kind the way a PR link's path does, so only the hosts the user trusts can be
 * told apart, and those are the only ones that get a token anyway.
 */
export function trustedHostKind(origin: string, trusted: TrustedOrigins): GitHostKind | undefined {
  if (origin === GITHUB_DOT_COM_ORIGIN || trusted.github.includes(origin)) return GitHostKind.GitHub
  if (origin === GITLAB_DOT_COM_ORIGIN || trusted.gitlab.includes(origin)) return GitHostKind.GitLab
  return undefined
}
