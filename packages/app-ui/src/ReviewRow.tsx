import type { ReactElement, ReactNode } from "react"
import { ReviewStatus, RiskSeverity, stepPosition } from "@walkdiff/review-model"
import type { AiDestination, ReviewSummary } from "@walkdiff/review-model"
import { progressLabel, readProgress } from "./progress.ts"
import { StackOfferBanner } from "./StackOffer.tsx"
import { isWorking } from "./stackList.ts"

export const TROUBLESHOOTING_URL = "https://github.com/navasvarela/walkdiff/blob/main/docs/troubleshooting.md"

const STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  [ReviewStatus.Queued]: "Queued",
  [ReviewStatus.Analyzing]: "Analyzing…",
  [ReviewStatus.Ready]: "Ready",
  [ReviewStatus.Failed]: "Failed",
}

const LEVEL_LABELS: Readonly<Record<RiskSeverity, string>> = {
  [RiskSeverity.High]: "High severity finding",
  [RiskSeverity.Medium]: "Medium severity finding",
  [RiskSeverity.Low]: "Low severity finding",
}

/** What a row can ask the list to do. */
export interface ReviewActions {
  readonly refresh: () => void
  readonly attachCoverage: (files: readonly File[]) => void
  readonly remove: () => void
  readonly acceptStack: (ai: boolean) => void
  readonly dismissStack: () => void
}

interface ReviewRowProps {
  readonly review: ReviewSummary
  /** The whole list, so an offer can tell which members are on it already. */
  readonly reviews: readonly ReviewSummary[]
  readonly destination: AiDestination | undefined
  readonly actions: ReviewActions
  /** Shown before the title, such as its place in a stack. */
  readonly badge?: ReactNode
  /** Shown under the details, such as what the host says of it now. */
  readonly children?: ReactNode
}

export function ReviewRow({ review, reviews, destination, actions, badge, children }: ReviewRowProps): ReactElement {
  const working = isWorking(review)
  return (
    <div className="review">
      <div className="review-main">
        {badge}
        {review.securityLevel !== null && review.securityLevel !== RiskSeverity.Low && <span className={`level level-${review.securityLevel}`}>{LEVEL_LABELS[review.securityLevel]}</span>}
        {review.hasReport ? (
          <a className="review-title" href={`/reviews/${review.id}/`}>
            {review.title ?? review.displayName}
          </a>
        ) : (
          <span className="review-title">{review.title ?? review.displayName}</span>
        )}
        {review.status !== ReviewStatus.Ready && <span className={`status status-${review.status}`}>{STATUS_LABELS[review.status]}</span>}
      </div>
      {review.status === ReviewStatus.Analyzing && <AnalysisProgress review={review} />}
      <ReviewMeta review={review} />
      {children}
      {review.error !== null && (
        <p className="problem">
          {review.error}{" "}
          <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer">
            How to fix this
          </a>
        </p>
      )}
      {review.stackOffer !== null && <StackOfferBanner review={review} offer={review.stackOffer} reviews={reviews} destination={destination} onAccept={actions.acceptStack} onDismiss={actions.dismissStack} />}
      <div className="review-actions">
        <button type="button" disabled={working} onClick={actions.refresh}>
          Refresh
        </button>
        {review.hasReport && !working && <AttachCoverageButton hasCoverage={review.coverageSource !== null} onAttach={actions.attachCoverage} />}
        <button type="button" onClick={actions.remove}>
          Remove
        </button>
      </div>
    </div>
  )
}

function ReviewMeta({ review }: { readonly review: ReviewSummary }): ReactElement {
  return (
    <p className="review-meta">
      <a href={review.url} target="_blank" rel="noreferrer">
        {review.displayName}
      </a>
      {review.author !== null && <> by {review.author}</>}
      {review.unitsToReview !== null && <> · {review.unitsToReview} to review</>}
      {review.untouchedReferences !== null && review.untouchedReferences > 0 && <> · {review.untouchedReferences} untouched callers</>}
      {review.findings !== null && (
        <>
          {" "}
          · {review.findings} {review.findings === 1 ? "finding" : "findings"}
        </>
      )}
      {review.ai && <> · AI</>}
      {review.hasReport && <> · {progressLabel(readProgress(review))}</>}
      {review.hasReport && <> · {coverageLabel(review.coverageSource)}</>}
      <> · updated {new Date(review.updatedAt).toLocaleString()}</>
    </p>
  )
}

/**
 * Which step an analysis is on, as a bar. It moves a step at a time rather than by a made-up
 * percentage: steps take very different times, and scanning is usually the longest.
 */
function AnalysisProgress({ review }: { readonly review: ReviewSummary }): ReactElement {
  if (review.step === null) {
    return <div className="progress progress-starting" role="progressbar" aria-label="Starting the analysis" />
  }
  const { number, total, label } = stepPosition(review.step, review.ai)
  return (
    <div className="analysis-progress">
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={number - 1} aria-valuetext={`Step ${number} of ${total}: ${label}`}>
        <div className="progress-done" style={{ width: `${((number - 1) / total) * 100}%` }} />
        <div className="progress-current" style={{ left: `${((number - 1) / total) * 100}%`, width: `${100 / total}%` }} />
      </div>
      <p className="progress-label">
        Step {number} of {total}: {label}…
      </p>
    </div>
  )
}

function coverageLabel(source: string | null): string {
  return source === null ? "no coverage found" : `coverage from ${source}`
}

interface AttachCoverageButtonProps {
  readonly hasCoverage: boolean
  readonly onAttach: (files: readonly File[]) => void
}

function AttachCoverageButton({ hasCoverage, onAttach }: AttachCoverageButtonProps): ReactElement {
  return (
    <label className="file-button" title="An LCOV or Cobertura report from this PR's latest commit. Applies to this PR only.">
      {hasCoverage ? "Replace coverage" : "Attach coverage"}
      <input
        type="file"
        multiple
        accept=".info,.lcov,.xml"
        onChange={(event) => {
          onAttach([...(event.target.files ?? [])])
          // Cleared so that picking the same file again, after regenerating it, still fires.
          event.target.value = ""
        }}
      />
    </label>
  )
}
