import { GitHostKind } from "@walkdiff/review-model"
import type { HostTokens } from "./gitHost.ts"
import { GitHubDirectory } from "./githubDirectory.ts"
import { GitLabDirectory } from "./gitlabDirectory.ts"
import type { PullRequestDirectory } from "./pullRequestDirectory.ts"
import type { RepositoryRef } from "./pullRequestUrl.ts"
import { isTrustedHost } from "./trustedHosts.ts"

/** Like `gitHostFor`, the token only goes to a host the user trusts for it. */
export function pullRequestDirectoryFor(repository: RepositoryRef, tokens: HostTokens): PullRequestDirectory {
  const trusted = isTrustedHost(repository, tokens.trustedOrigins)
  switch (repository.host) {
    case GitHostKind.GitHub:
      return new GitHubDirectory(repository, trusted ? tokens.github : undefined)
    case GitHostKind.GitLab:
      return new GitLabDirectory(repository, trusted ? tokens.gitlab : undefined)
  }
}
