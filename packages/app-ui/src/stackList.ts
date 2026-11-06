import { MemberCheck, numberLabel, PullRequestState, ReportChange, ReviewerState, ReviewStatus } from "@walkdiff/review-model"
import type { CommitSha, ProgressRecord, ReviewSummary, StackMember, StackMemberStatus, StackOffer, StackView } from "@walkdiff/review-model"

export const EntryKind = { Review: "review", Stack: "stack" } as const

/** One item of the review list: a review on its own, or a grouped stack shown as one card. */
export type ListEntry = { readonly kind: typeof EntryKind.Review; readonly review: ReviewSummary } | { readonly kind: typeof EntryKind.Stack; readonly id: number; readonly members: readonly ReviewSummary[] }

/** Keeps the list's order, putting each stack where its first member comes, with members bottom first. */
export function listEntries(reviews: readonly ReviewSummary[]): ListEntry[] {
  const entries: ListEntry[] = []
  const placed = new Set<number>()
  for (const review of reviews) {
    if (review.stack === null) {
      entries.push({ kind: EntryKind.Review, review })
      continue
    }
    const { id } = review.stack
    if (placed.has(id)) continue
    placed.add(id)
    const members = reviews.filter((other) => other.stack?.id === id).toSorted((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0))
    entries.push({ kind: EntryKind.Stack, id, members })
  }
  return entries
}

/**
 * The web address of another PR in the review's repository. Review URLs are canonical, ending in
 * the PR's number, so a member's is the same with its number.
 */
export function siblingUrl(review: ReviewSummary, number: number): string {
  return review.url.replace(/\d+$/, String(number))
}

export function memberName(review: ReviewSummary, member: StackMember): string {
  return `${numberLabel(review.host, member.number)} ${member.title}`
}

/** The offered members accepting would add as new reviews, rather than group from the list. */
export function newToList(offer: StackOffer, review: ReviewSummary, reviews: readonly ReviewSummary[]): number[] {
  const listed = new Set(reviews.map((other) => other.url))
  return offer.joining.filter((number) => !listed.has(siblingUrl(review, number)))
}

export const Tone = { Good: "good", Attention: "attention", Muted: "muted", Problem: "problem" } as const
export type Tone = (typeof Tone)[keyof typeof Tone]

export interface StateLabel {
  readonly text: string
  readonly tone: Tone
}

/** What the host says of a member now, as short labels. */
export function memberStateLabels(status: StackMemberStatus): StateLabel[] {
  if (status.check === MemberCheck.Failed) return [{ text: `Couldn't check: ${status.error}`, tone: Tone.Problem }]
  if (status.status.state === PullRequestState.Merged) return [{ text: "Merged", tone: Tone.Muted }]
  if (status.status.state === PullRequestState.Closed) return [{ text: "Closed", tone: Tone.Muted }]
  const labels: StateLabel[] = []
  const change = changeLabel(status.reportChange, status.status.baseRef)
  if (change !== undefined) labels.push(change)
  const approvedBy = namesIn(status, ReviewerState.Approved)
  if (approvedBy.length > 0) labels.push({ text: `Approved by ${approvedBy.join(", ")}`, tone: Tone.Good })
  const changesBy = namesIn(status, ReviewerState.ChangesRequested)
  if (changesBy.length > 0) labels.push({ text: `Changes requested by ${changesBy.join(", ")}`, tone: Tone.Attention })
  return labels
}

function changeLabel(change: ReportChange, baseRef: string): StateLabel | undefined {
  switch (change) {
    case ReportChange.None:
      return undefined
    case ReportChange.NoReport:
      return { text: "No report yet", tone: Tone.Attention }
    case ReportChange.NewCommits:
      return { text: "New commits", tone: Tone.Attention }
    case ReportChange.Retargeted:
      return { text: `Retargeted to ${baseRef}`, tone: Tone.Attention }
  }
}

function namesIn(status: StackMemberStatus, state: ReviewerState): string[] {
  return status.check === MemberCheck.Checked ? status.reviewers.filter((reviewer) => reviewer.state === state).map((reviewer) => reviewer.name) : []
}

/** "merged" or "closed" for a member the card shows apart as done; undefined for an open one, or one not checked yet. */
export function doneState(status: StackMemberStatus | undefined): string | undefined {
  if (status?.check !== MemberCheck.Checked || status.status.state === PullRequestState.Open) return undefined
  return status.status.state
}

export function isDone(status: StackMemberStatus | undefined): boolean {
  return doneState(status) !== undefined
}

/** "3 PRs · 1 approved · 2 need a refresh", counting open members only. */
export function stackHeadline(members: readonly ReviewSummary[], view: StackView | undefined): string {
  const statuses = view?.members ?? []
  const open = members.length - statuses.filter(isDone).length
  const parts = [`${open} ${open === 1 ? "PR" : "PRs"}`]
  const approved = statuses.filter((status) => !isDone(status) && namesIn(status, ReviewerState.Approved).length > 0).length
  if (approved > 0) parts.push(`${approved} approved`)
  const stale = statuses.filter((status) => status.check === MemberCheck.Checked && status.reportChange !== ReportChange.None).length
  if (stale > 0) parts.push(`${stale} ${stale === 1 ? "needs" : "need"} a refresh`)
  return parts.join(" · ")
}

export function isWorking(review: ReviewSummary): boolean {
  return review.status === ReviewStatus.Queued || review.status === ReviewStatus.Analyzing
}

/** What the approve-all dialog says of one member before anything is posted. */
export type ApprovalCheck =
  | { readonly ready: true; readonly headSha: CommitSha; readonly warnings: readonly string[] }
  | { readonly ready: false; readonly blocker: string }

/**
 * Whether a member can be approved with the rest. Anything that would approve other code than
 * the report showed blocks; things the reviewer may well mean to do, such as approving before
 * finishing the path, only warn.
 */
export function approvalCheck(status: StackMemberStatus | undefined, progress: ProgressRecord | undefined): ApprovalCheck {
  if (status === undefined) return { ready: false, blocker: "Still checking with the host." }
  if (status.check === MemberCheck.Failed) return { ready: false, blocker: `Couldn't check it: ${status.error}` }
  switch (status.reportChange) {
    case ReportChange.NoReport:
      return { ready: false, blocker: "It has no report yet." }
    case ReportChange.NewCommits:
      return { ready: false, blocker: "It has new commits. Refresh it first." }
    case ReportChange.Retargeted:
      return { ready: false, blocker: `It merges into ${status.status.baseRef} now. Refresh it first.` }
    case ReportChange.None:
      return { ready: true, headSha: status.status.headSha, warnings: approvalWarnings(progress) }
  }
}

function approvalWarnings(progress: ProgressRecord | undefined): string[] {
  const warnings: string[] = []
  if (progress !== undefined && progress.drafts > 0) {
    const comments = progress.drafts === 1 ? "a comment" : `${progress.drafts} comments`
    warnings.push(`It has ${comments} you haven't posted. Open it to post them, or approve without them.`)
  }
  if (progress === undefined || progress.reviewed < progress.total) {
    warnings.push(progress === undefined || progress.reviewed === 0 ? "You haven't started reviewing it." : `You've reviewed ${progress.reviewed} of ${progress.total} changes.`)
  }
  return warnings
}

/** Links come from the host's answer, so only web addresses become clickable. */
export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
