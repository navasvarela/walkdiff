import { useMemo } from "react"
import type { ReactElement } from "react"
import { isHostedPullRequest, numberLabel } from "@walkdiff/review-model"
import type { ReviewModel } from "@walkdiff/review-model"
import { overallProgress, pathProgress, reviewPlanFor } from "../reviewProgress.ts"
import { useReviewState } from "../reviewState.tsx"
import { REVIEW_HASH } from "../reviewPlan.ts"
import { ReportTab } from "../tabs.ts"
import { homeUrl } from "./PullRequestHeader.tsx"
import { StackStrip } from "./StackStrip.tsx"

const ALL_CHANGES_HASH = `#${ReportTab.Changes}`

export const TopBarSection = { Review: "review", AllChanges: "allChanges" } as const
export type TopBarSection = (typeof TopBarSection)[keyof typeof TopBarSection]

interface TopBarProps {
  readonly review: ReviewModel
  readonly section: TopBarSection
}

/** Says where you are on every page, and keeps the guided review and the full lists one click apart. */
export function TopBar({ review, section }: TopBarProps): ReactElement {
  const { state, changedAtOpen } = useReviewState()
  const plan = useMemo(() => reviewPlanFor(review, changedAtOpen), [review, changedAtOpen])
  const path = pathProgress(plan, state)
  const overall = overallProgress(review.files, state)
  const home = homeUrl()
  const { pullRequest } = review
  return (
    <>
      <header className="topbar">
        <div className="topbar-trail">
          <span className="topbar-brand">
            <Logo />
            Walkdiff
          </span>
          {home !== undefined && (
            <>
              <span className="topbar-separator" aria-hidden="true">
                /
              </span>
              <a href={home}>All reviews</a>
            </>
          )}
          <span className="topbar-separator" aria-hidden="true">
            /
          </span>
          {isHostedPullRequest(pullRequest) ? (
            <a href={pullRequest.url} target="_blank" rel="noreferrer">
              {numberLabel(pullRequest.host, pullRequest.number)}
            </a>
          ) : (
            <span>{pullRequest.repositoryName} · local branch</span>
          )}
        </div>
        <nav className="topbar-nav" aria-label="Review sections">
          <a href={REVIEW_HASH} aria-current={section === TopBarSection.Review ? "page" : undefined}>
            Review
          </a>
          <a href={ALL_CHANGES_HASH} aria-current={section === TopBarSection.AllChanges ? "page" : undefined}>
            All changes
          </a>
        </nav>
        <p className="topbar-progress">
          {path.reviewed} of {path.total} on the path · {overall.reviewed} of {overall.total} overall
        </p>
      </header>
      <StackStrip />
    </>
  )
}

// Inline because a report is one self-contained file, and matches docs/assets/walkdiff-logo.svg.
function Logo(): ReactElement {
  return (
    <svg className="topbar-logo" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
      <defs>
        <linearGradient id="walkdiff-walk" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f85149" />
          <stop offset="1" stopColor="#3fb950" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#0d1117" />
      <path d="M11 18 L22 46 L32 26 L42 46 L53 18" fill="none" stroke="url(#walkdiff-walk)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="18" r="5.5" fill="#f85149" />
      <circle cx="32" cy="26" r="4" fill="#e6edf3" />
      <circle cx="53" cy="18" r="5.5" fill="#3fb950" />
    </svg>
  )
}
