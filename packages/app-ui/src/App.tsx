import { useCallback, useEffect, useState } from "react"
import type { FormEvent, ReactElement } from "react"
import type { AiDestination, ReviewSummary } from "@walkdiff/review-model"
import { aiOptionLabel, useAiChoice } from "./aiChoice.ts"
import { acceptStack, addReview, attachCoverage, dismissStackOffer, listReviews, refreshReview, removeReview } from "./api.ts"
import logoUrl from "../../../docs/assets/walkdiff-logo.svg"
import { ReviewRow, TROUBLESHOOTING_URL } from "./ReviewRow.tsx"
import type { ReviewActions } from "./ReviewRow.tsx"
import { Settings } from "./Settings.tsx"
import { StackCard } from "./StackCard.tsx"
import { EntryKind, isWorking, listEntries } from "./stackList.ts"

const DOCS_URL = "https://github.com/navasvarela/walkdiff/blob/main/docs/README.md"

// Often enough that an analysis finishing feels immediate; only while one is running.
const POLL_INTERVAL_MS = 1500

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

  const aiChoice = useAiChoice()
  const busy = reviews?.some(isWorking) ?? false
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
  const actionsFor = (review: ReviewSummary): ReviewActions => ({
    refresh: () => act(() => refreshReview(review.id)),
    attachCoverage: (files) => act(() => attachCoverage(review.id, files)),
    remove: () => act(() => removeReview(review.id)),
    acceptStack: (ai) => act(() => acceptStack(review.id, { ai })),
    dismissStack: () => act(() => dismissStackOffer(review.id)),
  })

  return (
    <main className="page">
      <h1>Reviews</h1>
      <AddReviewForm onAdded={reload} destination={aiChoice.destination} enabledByDefault={aiChoice.enabledByDefault} />
      {aiChoice.problem !== undefined && <p className="problem">{aiChoice.problem}</p>}
      {problem !== undefined && <p className="problem">{problem}</p>}
      {reviews === undefined ? null : reviews.length === 0 ? (
        <p className="empty">Nothing here yet. Paste a pull request or merge request link above to start a review.</p>
      ) : (
        <ul className="reviews">
          {listEntries(reviews).map((entry) =>
            entry.kind === EntryKind.Review ? (
              <li key={`review-${entry.review.id}`}>
                <ReviewRow review={entry.review} reviews={reviews} destination={aiChoice.destination} actions={actionsFor(entry.review)} />
              </li>
            ) : (
              <li key={`stack-${entry.id}`}>
                <StackCard id={entry.id} members={entry.members} reviews={reviews} destination={aiChoice.destination} actionsFor={actionsFor} act={act} />
              </li>
            ),
          )}
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
  readonly destination: AiDestination | undefined
  readonly enabledByDefault: boolean
}

function AddReviewForm({ onAdded, destination, enabledByDefault }: AddReviewFormProps): ReactElement {
  const [url, setUrl] = useState("")
  const [ai, setAi] = useState(false)
  const [problem, setProblem] = useState<string>()

  // The saved default arrives after the first render.
  useEffect(() => setAi(enabledByDefault), [enabledByDefault])

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
