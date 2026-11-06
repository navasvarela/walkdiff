import { HostApiError, parsePullRequestUrl } from "@walkdiff/providers"
import type { GitHost, PullRequestRef } from "@walkdiff/providers"
import { MemberCheck, PullRequestState, ReportChange } from "@walkdiff/review-model"
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
    return { check: MemberCheck.Checked, reviewId: member.id, status, reportChange: reportChange(analyzed, status), reviewers: conversation.reviewers }
  } catch (error: unknown) {
    if (!(error instanceof HostApiError)) throw error
    return { check: MemberCheck.Failed, reviewId: member.id, error: error.message }
  }
}

/**
 * Why an open PR's report is out of date. A new base wins over new commits: rebasing onto the
 * new base usually brings both, and the base is what moves the whole diff.
 */
export function reportChange(analyzed: AnalyzedHead | undefined, status: PullRequestStatus): ReportChange {
  if (status.state !== PullRequestState.Open) return ReportChange.None
  if (analyzed === undefined) return ReportChange.NoReport
  if (analyzed.baseRef !== status.baseRef) return ReportChange.Retargeted
  return analyzed.headSha === status.headSha ? ReportChange.None : ReportChange.NewCommits
}
