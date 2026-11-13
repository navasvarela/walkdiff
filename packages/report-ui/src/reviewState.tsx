import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactElement, ReactNode } from "react"
import { isHostedPullRequest, progressKey } from "@walkdiff/review-model"
import type { ProgressRecord, PullRequest, ReviewModel } from "@walkdiff/review-model"
import { changedSinceReview, EMPTY_REVIEW_STATE, overallProgress, parseSavedState, serializeState, withComment, withReviewed } from "./reviewProgress.ts"
import type { ReviewItem, ReviewState } from "./reviewProgress.ts"

const STORAGE_KEY_PREFIX = "walkdiff-review:"

export interface ReviewStateActions {
  readonly state: ReviewState
  /** What had changed when the page opened. It stays put, so the path doesn't move during a review. */
  readonly changedAtOpen: readonly ReviewItem[]
  /** The record as it was when the page opened, for showing what changed since. */
  readonly stateAtOpen: ReviewState
  readonly setReviewed: (items: readonly ReviewItem[], reviewed: boolean) => void
  readonly setComment: (id: string, text: string) => void
}

const ReviewStateContext = createContext<ReviewStateActions>({ state: EMPTY_REVIEW_STATE, changedAtOpen: [], stateAtOpen: EMPTY_REVIEW_STATE, setReviewed: () => undefined, setComment: () => undefined })

export function useReviewState(): ReviewStateActions {
  return useContext(ReviewStateContext)
}

interface ReviewStateProviderProps {
  readonly review: ReviewModel
  readonly children: ReactNode
}

/**
 * What a review's progress is saved under: the PR's address, so a report made after a push
 * picks up where the reviewer left off. A local branch has no address, so its repository and
 * branch name stand in.
 */
function savedAs(pullRequest: PullRequest): string {
  return isHostedPullRequest(pullRequest) ? pullRequest.url : `local:${pullRequest.repositoryName}:${pullRequest.headRef}`
}

/**
 * Keeps progress and comments in this browser, per pull request, so they survive a new push.
 * Storage can be unavailable or full, as in a private window or some reports opened from disk:
 * the review then lasts until the page closes.
 */
export function ReviewStateProvider({ review, children }: ReviewStateProviderProps): ReactElement {
  const key = `${STORAGE_KEY_PREFIX}${savedAs(review.pullRequest)}`
  const [stateAtOpen] = useState(() => parseSavedState(readStorage(key)))
  const [state, setState] = useState(stateAtOpen)
  const changedAtOpen = useMemo(() => changedSinceReview(review.files, stateAtOpen), [review.files, stateAtOpen])
  // Saved on open too, so the app's list catches up with a report re-made after a push.
  useEffect(() => {
    const { headSha, baseRef } = review.pullRequest
    const progress: ProgressRecord = { ...overallProgress(review.files, state), drafts: state.comments.size, head: { headSha, baseRef } }
    writeStorage(progressKey(savedAs(review.pullRequest)), JSON.stringify(progress))
  }, [review.files, review.pullRequest, state])
  const update = useCallback(
    (change: (current: ReviewState) => ReviewState): void => {
      setState((current) => {
        const next = change(current)
        writeStorage(key, serializeState(next))
        return next
      })
    },
    [key],
  )
  const value = useMemo(
    () => ({
      state,
      changedAtOpen,
      stateAtOpen,
      setReviewed: (items: readonly ReviewItem[], reviewed: boolean): void => update((current) => withReviewed(current, items, reviewed)),
      setComment: (id: string, text: string): void => update((current) => withComment(current, id, text)),
    }),
    [state, changedAtOpen, stateAtOpen, update],
  )
  return <ReviewStateContext.Provider value={value}>{children}</ReviewStateContext.Provider>
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Progress is a convenience: without storage it lasts until the page closes.
  }
}
