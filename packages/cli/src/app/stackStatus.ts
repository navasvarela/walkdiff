import { HostApiError, parsePullRequestUrl } from "@walkdiff/providers"
import type { GitHost, PullRequestRef } from "@walkdiff/providers"
import { MemberCheck, PullRequestState } from "@walkdiff/review-model"
import type { PullRequestStatus, ReviewSummary, StackMemberStatus, StackView } from "@walkdiff/review-model"
import type { AnalyzedHead, ReviewStore } from "./reviewStore.ts"

export type HostResolver = (ref: PullRequestRef) => Promise<GitHost>

/**
 * A grouped stack with each member's state read from its host now, bottom first. One member's
 * host failing is shown on that member, so the rest of the stack still reads. Undefined if there
 * is no such stack.
 */
export async function readStackView(store: ReviewStore, stackId: number, hostFor: HostResolver): Promise<StackView | undefined> {
  const stack = store.stack(stackId)
  if (stack === undefined) return undefined
  const members = await Promise.all(store.stackMembers(stackId).map((member) => memberStatus(member, store.analyzedHeadOf(member.id), hostFor)))
  return { id: stack.id, trunk: stack.trunk, members }
}

async function memberStatus(member: ReviewSummary, analyzed: AnalyzedHead | undefined, hostFor: HostResolver): Promise<StackMemberStatus> {
  try {
    // The host comes from the saved review, whose URL the app built itself.
    const host = await hostFor(parsePullRequestUrl(member.url))
    const [status, conversation] = await Promise.all([host.fetchStatus(), host.fetchConversation()])
    return { check: MemberCheck.Checked, reviewId: member.id, status, needsRefresh: needsRefresh(analyzed, status), reviewers: conversation.reviewers }
  } catch (error: unknown) {
    if (!(error instanceof HostApiError)) throw error
    return { check: MemberCheck.Failed, reviewId: member.id, error: error.message }
  }
}

/**
 * An open PR's report is out of date when it has new commits, or merges into another branch now,
 * as when the member below it merged: its diff then runs from a different base.
 */
export function needsRefresh(analyzed: AnalyzedHead | undefined, status: PullRequestStatus): boolean {
  if (status.state !== PullRequestState.Open) return false
  return analyzed === undefined || analyzed.headSha !== status.headSha || analyzed.baseRef !== status.baseRef
}
