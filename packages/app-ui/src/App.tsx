import { useCallback, useEffect, useState } from "react"
import type { FormEvent, ReactElement } from "react"
import { aiDestination, ReviewStatus, RiskSeverity, stepPosition } from "@walkdiff/review-model"
import type { AiDestination, ReviewSummary } from "@walkdiff/review-model"
import { addReview, attachCoverage, listReviews, loadCurrentSettings, refreshReview, removeReview } from "./api.ts"
import logoUrl from "../../../docs/assets/walkdiff-logo.svg"
import { Settings } from "./Settings.tsx"

const DOCS_URL = "https://github.com/navasvarela/walkdiff/blob/main/docs/README.md"
const TROUBLESHOOTING_URL = "https://github.com/navasvarela/walkdiff/blob/main/docs/troubleshooting.md"

// Often enough that an analysis finishing feels immediate; only while one is running.
const POLL_INTERVAL_MS = 1500

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

const SETTINGS_HASH = "#settings"
const HOME_HASH = "#"

/** The page named by the URL, so the back button and links work. */
export function App(): ReactElement {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const followHash = (): void => setHash(window.location.hash)
    window.addEventListener("hashchange", followHash)
    return () => window.removeEventListener("hashchange", followHash)
  }, [])
  const onSettings = hash === SETTINGS_HASH
  return (
    <>
      <TopBar onSettings={onSettings} />
      {onSettings ? <Settings /> : <ReviewList />}
    </>
  )
}

/** Matches the report's bar, so moving between the list and a review feels like one app. */
function TopBar({ onSettings }: { readonly onSettings: boolean }): ReactElement {
  return (
    <header className="topbar">
      <a className="topbar-brand" href={HOME_HASH}>
        <img src={logoUrl} alt="" width="22" height="22" />
        Walkdiff
      </a>
      <nav className="topbar-nav" aria-label="Sections">
        <a href={HOME_HASH} aria-current={onSettings ? undefined : "page"}>
          Reviews
        </a>
        <a href={SETTINGS_HASH} aria-current={onSettings ? "page" : undefined}>
          Settings
        </a>
      </nav>
    </header>
  )
}

function ReviewList(): ReactElement {
  const [reviews, setReviews] = useState<readonly ReviewSummary[]>()
  const [problem, setProblem] = useState<string>()

  const reload = useCallback(async (): Promise<void> => {
    try {
      setReviews(await listReviews())
      setProblem(undefined)
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const busy = reviews?.some((review) => review.status === ReviewStatus.Queued || review.status === ReviewStatus.Analyzing) ?? false
  useEffect(() => {
    if (!busy) return undefined
    const timer = window.setInterval(() => void reload(), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [busy, reload])

  const act = (action: () => Promise<void>): void => {
    void action()
      .then(reload)
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  }

  return (
    <main className="page">
      <h1>Reviews</h1>
      <AddReviewForm onAdded={reload} />
      {problem !== undefined && <p className="problem">{problem}</p>}
      {reviews === undefined ? null : reviews.length === 0 ? (
        <p className="empty">Nothing here yet. Paste a pull request or merge request link above to start a review.</p>
      ) : (
        <ul className="reviews">
          {reviews.map((review) => (
            <ReviewRow
              key={review.id}
              review={review}
              onRefresh={() => act(() => refreshReview(review.id))}
              onAttachCoverage={(files) => act(() => attachCoverage(review.id, files))}
              onRemove={() => act(() => removeReview(review.id))}
            />
          ))}
        </ul>
      )}
      <footer className="page-footer">
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          Documentation
        </a>
        <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer">
          Troubleshooting
        </a>
      </footer>
    </main>
  )
}

interface AddReviewFormProps {
  readonly onAdded: () => Promise<void>
}

function AddReviewForm({ onAdded }: AddReviewFormProps): ReactElement {
  const [url, setUrl] = useState("")
  const [ai, setAi] = useState(false)
  const [destination, setDestination] = useState<AiDestination>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    loadCurrentSettings()
      .then(({ settings, anthropicBaseUrl }) => {
        setAi(settings.ai.enabledByDefault)
        setDestination(aiDestination(settings.ai, anthropicBaseUrl ?? undefined))
      })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  }, [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    addReview({ url, ai })
      .then(() => {
        setUrl("")
        setProblem(undefined)
        return onAdded()
      })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  }

  return (
    <form className="add-review" onSubmit={submit}>
      <div className="add-row">
        <input
          type="url"
          value={url}
          required
          autoFocus
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request or merge request link"
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit">Add review</button>
      </div>
      <label className="add-option">
        <input type="checkbox" checked={ai} onChange={(event) => setAi(event.target.checked)} />
        {aiOptionLabel(destination)} <a href={SETTINGS_HASH}>Change</a>
      </label>
      {problem !== undefined && <p className="problem">{problem}</p>}
    </form>
  )
}

function aiOptionLabel(destination: AiDestination | undefined): string {
  if (destination === undefined) return "Include AI review"
  if (destination.isLocal) return "Include AI review (uses a model on this machine; your code stays here)"
  return `Include AI review (sends the changed code to ${destination.label}, and may cost money)`
}

interface ReviewRowProps {
  readonly review: ReviewSummary
  readonly onRefresh: () => void
  readonly onAttachCoverage: (files: readonly File[]) => void
  readonly onRemove: () => void
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

function ReviewRow({ review, onRefresh, onAttachCoverage, onRemove }: ReviewRowProps): ReactElement {
  const working = review.status === ReviewStatus.Queued || review.status === ReviewStatus.Analyzing
  return (
    <li className="review">
      <div className="review-main">
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
        {review.hasReport && <> · {coverageLabel(review.coverageSource)}</>}
        <> · updated {new Date(review.updatedAt).toLocaleString()}</>
      </p>
      {review.error !== null && (
        <p className="problem">
          {review.error}{" "}
          <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer">
            How to fix this
          </a>
        </p>
      )}
      <div className="review-actions">
        <button type="button" disabled={working} onClick={onRefresh}>
          Refresh
        </button>
        {review.hasReport && !working && <AttachCoverageButton hasCoverage={review.coverageSource !== null} onAttach={onAttachCoverage} />}
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
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
