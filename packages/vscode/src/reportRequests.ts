import { ReportRequestMethod } from "@walkdiff/review-model"

/**
 * The app API calls a report panel may have the extension make, all of which the report page makes
 * in the app: the review list, for the stack strip, and this review's conversation, posting and
 * thread actions. Anything else, including another review's, is refused, so a page can't use the
 * extension's key for more than its own review.
 */
export function isAllowedRequest(reviewId: number, method: ReportRequestMethod, path: string): boolean {
  const own = `/api/reviews/${reviewId}`
  if (method === ReportRequestMethod.Get) return path === "/api/reviews" || path === `${own}/conversation`
  if (path === `${own}/submit`) return true
  const thread = path.startsWith(`${own}/threads/`) ? path.slice(`${own}/threads/`.length).split("/") : []
  return thread.length === 2 && thread[0] !== "" && (thread[1] === "reply" || thread[1] === "resolve")
}
