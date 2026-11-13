import { CitationSide, GitHostKind, isHostedPullRequest } from "@walkdiff/review-model"
import type { PullRequest } from "@walkdiff/review-model"

/**
 * A link to a line of a file on the host's own file viewer: at the head commit by default,
 * or at the merge base for lines that exist only before the change. Undefined for a local
 * branch, which has no web page to link to.
 */
export function sourceLineUrl(pullRequest: PullRequest, path: string, line: number, side: CitationSide = CitationSide.After): string | undefined {
  if (!isHostedPullRequest(pullRequest)) return undefined
  const commit = side === CitationSide.Before ? pullRequest.mergeBaseSha : pullRequest.headSha
  const encodedPath = path.split("/").map(encodeURIComponent).join("/")
  const blobSegment = pullRequest.host === GitHostKind.GitLab ? "-/blob" : "blob"
  return `${pullRequest.repositoryWebUrl}/${blobSegment}/${commit}/${encodedPath}#L${line}`
}
