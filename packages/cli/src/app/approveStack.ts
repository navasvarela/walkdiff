import { HostApiError, parsePullRequestUrl } from "@walkdiff/providers"
import type { GitHost } from "@walkdiff/providers"
import { ApprovalOutcome, PullRequestState, ReportChange, ReviewEvent } from "@walkdiff/review-model"
import type { ApproveStackRequest, BlockedMember, MemberApproval, PullRequestStatus, ReviewSummary } from "@walkdiff/review-model"
import type { AnalyzedHead, ReviewStore } from "./reviewStore.ts"
import { reportChange } from "./stackStatus.ts"
import type { HostResolver } from "./stackStatus.ts"

export const ApproveKind = { NoStack: "noStack", Blocked: "blocked", Done: "done" } as const

export type ApproveResult =
  | { readonly kind: typeof ApproveKind.NoStack }
  | { readonly kind: typeof ApproveKind.Blocked; readonly blocked: readonly BlockedMember[] }
  | { readonly kind: typeof ApproveKind.Done; readonly results: readonly MemberApproval[] }

interface Checked {
  readonly member: ReviewSummary
  readonly host: GitHost
  readonly analyzed: AnalyzedHead
}

type Preflight = { readonly passed: true; readonly checked: Checked } | { readonly passed: false; readonly blocked: BlockedMember }

/**
 * Approves the members asked for, bottom first. First every one is checked with its host, and if
 * any has moved on from the commit the reviewer saw, nothing is posted. Then each approval is posted
 * on its own: a host refusing one doesn't stop the rest, since approvals already posted can't safely
 * be taken back, and each stands for its own PR.
 */
export async function approveStack(store: ReviewStore, stackId: number, request: ApproveStackRequest, hostFor: HostResolver): Promise<ApproveResult> {
  if (store.stack(stackId) === undefined) return { kind: ApproveKind.NoStack }
  const members = store.stackMembers(stackId)
  const inStack = new Set(members.map((member) => member.id))
  const strangers: BlockedMember[] = request.members.filter(({ reviewId }) => !inStack.has(reviewId)).map(({ reviewId }) => ({ reviewId, reason: "It isn't in this stack." }))
  if (strangers.length > 0) return { kind: ApproveKind.Blocked, blocked: strangers }

  const seen = new Map(request.members.map(({ reviewId, headSha }) => [reviewId, headSha]))
  const preflights = await Promise.all(
    members.flatMap((member) => {
      const seenHead = seen.get(member.id)
      return seenHead === undefined ? [] : [preflight(store, member, seenHead, hostFor)]
    }),
  )
  const blocked = preflights.flatMap((result) => (result.passed ? [] : [result.blocked]))
  if (blocked.length > 0) return { kind: ApproveKind.Blocked, blocked }

  const results: MemberApproval[] = []
  // One at a time, so the hosts see them bottom first, as a reviewer would post them by hand.
  for (const result of preflights) {
    if (result.passed) results.push(await approve(result.checked, request.body))
  }
  return { kind: ApproveKind.Done, results }
}

async function preflight(store: ReviewStore, member: ReviewSummary, seenHead: string, hostFor: HostResolver): Promise<Preflight> {
  const block = (reason: string): Preflight => ({ passed: false, blocked: { reviewId: member.id, reason } })
  const analyzed = store.analyzedHeadOf(member.id)
  if (analyzed === undefined) return block(NO_REPORT)
  try {
    // The host comes from the saved review, whose URL the app built itself.
    const host = await hostFor(parsePullRequestUrl(member.url))
    const reason = blockReason(analyzed, await host.fetchStatus(), seenHead)
    return reason === undefined ? { passed: true, checked: { member, host, analyzed } } : block(reason)
  } catch (error: unknown) {
    if (!(error instanceof HostApiError)) throw error
    return block(`Walkdiff couldn't check it: ${error.message}`)
  }
}

const NO_REPORT = "It has no report yet."

/**
 * Why approving a member must wait. Its report must describe what the host has now, and be the
 * one the reviewer saw when they decided.
 */
export function blockReason(analyzed: AnalyzedHead, status: PullRequestStatus, seenHead: string): string | undefined {
  if (status.state !== PullRequestState.Open) return `It's ${status.state}.`
  switch (reportChange(analyzed, status)) {
    case ReportChange.NoReport:
      return NO_REPORT
    case ReportChange.NewCommits:
      return "It has new commits. Refresh it and look again."
    case ReportChange.Retargeted:
      return `It merges into ${status.baseRef} now, so its diff changed. Refresh it and look again.`
    case ReportChange.None:
      return analyzed.headSha === seenHead ? undefined : "Its report changed after you opened this. Look again."
  }
}

async function approve({ member, host, analyzed }: Checked, body: string): Promise<MemberApproval> {
  try {
    // Tied to the commit that was read, so the host can't apply it to a newer one.
    const { url } = await host.submitReview({ event: ReviewEvent.Approve, body, headSha: analyzed.headSha, comments: [] })
    return { outcome: ApprovalOutcome.Posted, reviewId: member.id, url }
  } catch (error: unknown) {
    if (!(error instanceof HostApiError)) throw error
    return { outcome: ApprovalOutcome.Refused, reviewId: member.id, error: error.message }
  }
}
