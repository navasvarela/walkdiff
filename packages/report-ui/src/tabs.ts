import { AiReviewStatus, changedUnitsOf, isBehaviourChange, untouchedReferences } from "@walkdiff/review-model"
import type { ReviewModel, RiskSeverity } from "@walkdiff/review-model"

export const ReportTab = { Changes: "changes", Impact: "impact", Risks: "risks", AiReview: "ai-review", Conversation: "conversation" } as const
export type ReportTab = (typeof ReportTab)[keyof typeof ReportTab]

const ALL_TABS: readonly ReportTab[] = [ReportTab.Changes, ReportTab.Impact, ReportTab.Risks, ReportTab.AiReview, ReportTab.Conversation]

/** The tab named in the URL, so a link or the back button can return to it. `#risks/supplyChain` is the Risks tab, at a section. */
export function tabFromHash(hash: string): ReportTab {
  return ALL_TABS.find((tab) => `#${tab}` === hash || hash.startsWith(`#${tab}/`)) ?? ReportTab.Changes
}

export interface TabSummary {
  readonly tab: ReportTab
  readonly label: string
  /** Shown beside the label; undefined when there is no number worth showing. */
  readonly count: string | undefined
  /** Colours the count, so a problem is visible from any other tab. */
  readonly tone: RiskSeverity | undefined
}

export function summarizeTabs(review: ReviewModel, openThreads?: number): TabSummary[] {
  const units = review.files.flatMap(changedUnitsOf)
  const untouched = units.reduce((sum, unit) => sum + untouchedReferences(unit).length, 0)
  return [
    { tab: ReportTab.Changes, label: "Changes", count: changesCount(review.files.length, units.filter((unit) => isBehaviourChange(unit.change)).length), tone: undefined },
    { tab: ReportTab.Impact, label: "Impact", count: String(untouched), tone: untouched > 0 ? "medium" : undefined },
    { tab: ReportTab.Risks, label: "Risks", count: String(review.risk.findings.length), tone: review.risk.securityLevel },
    { tab: ReportTab.AiReview, label: "AI review", count: review.ai.status === AiReviewStatus.Completed ? String(review.ai.questions.length) : undefined, tone: undefined },
    { tab: ReportTab.Conversation, label: "Conversation", count: openThreads === undefined || openThreads === 0 ? undefined : String(openThreads), tone: undefined },
  ]
}

// Two different numbers, so each names what it counts.
export function changesCount(files: number, units: number): string {
  return `${files} ${files === 1 ? "file" : "files"} · ${units} ${units === 1 ? "unit" : "units"}`
}

/** The next tab for an arrow key, wrapping at both ends. */
export function neighbourTab(current: ReportTab, step: 1 | -1): ReportTab {
  const index = ALL_TABS.indexOf(current)
  return ALL_TABS.at((index + step) % ALL_TABS.length) ?? current
}
