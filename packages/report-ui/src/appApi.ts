import { conversationSchema, ReportRequestMethod, reviewSummarySchema, submitResultSchema } from "@walkdiff/review-model"
import type { Conversation, ReviewSummary, SubmitResult, SubmitReview } from "@walkdiff/review-model"
import { host } from "./host.ts"

/** Only the local app, or an editor showing its report, gives the page a way to call it, so a report opened from a file or CI stays read-only. */
export function isConnectedToApp(): boolean {
  return host.reviewId !== undefined
}

/** This report's review id in the app; undefined outside it. */
export function reviewId(): number | undefined {
  return host.reviewId
}

function call(path: string, method: ReportRequestMethod, body?: unknown): Promise<unknown> {
  return host.call(method, `/api/reviews/${host.reviewId ?? ""}${path}`, body)
}

/** The app's whole review list, to find this PR's neighbours in its stack. */
export async function loadReviewList(): Promise<readonly ReviewSummary[]> {
  return reviewSummarySchema.array().parse(await host.call(ReportRequestMethod.Get, "/api/reviews"))
}

export async function loadConversation(): Promise<Conversation> {
  return conversationSchema.parse(await call("/conversation", ReportRequestMethod.Get))
}

export async function postReview(review: SubmitReview): Promise<SubmitResult> {
  return submitResultSchema.parse(await call("/submit", ReportRequestMethod.Post, review))
}

export async function replyToThread(threadId: string, body: string): Promise<void> {
  await call(`/threads/${encodeURIComponent(threadId)}/reply`, ReportRequestMethod.Post, { body })
}

export async function setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  await call(`/threads/${encodeURIComponent(threadId)}/resolve`, ReportRequestMethod.Post, { resolved })
}

/** Links come from the host's answer, so only web addresses become clickable. */
export function isWebLink(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url)
}
