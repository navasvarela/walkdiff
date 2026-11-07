import { ApprovalOutcome } from "@walkdiff/review-model"
import type { ApproveStackRequest, BlockedMember, MemberApproval } from "@walkdiff/review-model"
import { ApprovalAnswerKind } from "./api.ts"
import type { ApprovalAnswer, CheckAnswer } from "./api.ts"

export interface ApprovalCalls {
  readonly check: (request: ApproveStackRequest) => Promise<CheckAnswer>
  readonly approve: (request: ApproveStackRequest) => Promise<ApprovalAnswer>
}

export interface ApprovalListener {
  readonly posting: (reviewId: number) => void
  readonly posted: (result: MemberApproval) => void
}

export type ApprovalRun = { readonly kind: typeof ApprovalAnswerKind.Done } | { readonly kind: typeof ApprovalAnswerKind.Blocked; readonly blocked: readonly BlockedMember[] }

/**
 * Checks every member first, and posts nothing if one has moved on. Then posts the approvals in
 * order, one request each, so the reviewer sees each result as it comes: a GitLab approval takes
 * a few seconds. Like the server, it keeps going after a member fails.
 */
export async function approveInTurn(request: ApproveStackRequest, calls: ApprovalCalls, listener: ApprovalListener): Promise<ApprovalRun> {
  const check = await calls.check(request)
  if (check.kind === ApprovalAnswerKind.Blocked) return { kind: ApprovalAnswerKind.Blocked, blocked: check.blocked.blocked }
  for (const member of request.members) {
    listener.posting(member.reviewId)
    listener.posted(await approveOne({ body: request.body, members: [member] }, member.reviewId, calls))
  }
  return { kind: ApprovalAnswerKind.Done }
}

/** A member that changed since the check, or an app that stopped answering, counts as not approved. */
async function approveOne(request: ApproveStackRequest, reviewId: number, calls: ApprovalCalls): Promise<MemberApproval> {
  const refused = (error: string): MemberApproval => ({ outcome: ApprovalOutcome.Refused, reviewId, error })
  try {
    const answer = await calls.approve(request)
    if (answer.kind === ApprovalAnswerKind.Blocked) return refused(answer.blocked.blocked.find((entry) => entry.reviewId === reviewId)?.reason ?? answer.blocked.error)
    return answer.result.results.find((result) => result.reviewId === reviewId) ?? refused("The app didn't say what happened to it.")
  } catch (error: unknown) {
    return refused(error instanceof Error ? error.message : String(error))
  }
}
