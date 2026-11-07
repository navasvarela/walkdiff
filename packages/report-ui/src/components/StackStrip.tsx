import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import { numberLabel } from "@walkdiff/review-model"
import type { ReviewSummary } from "@walkdiff/review-model"
import { isConnectedToApp, loadReviewList, reviewId } from "../appApi.ts"
import { stackPlaceOf } from "../stackPlace.ts"
import type { StackPlace } from "../stackPlace.ts"

/**
 * "Stack · 2 of 3", with links to the reports either side, so a reviewer can walk the stack.
 * Only the app knows the stack, so a report opened from a file or CI shows nothing.
 */
const Direction = { Below: "below", Above: "above" } as const
type Direction = (typeof Direction)[keyof typeof Direction]

export function StackStrip(): ReactElement | null {
  const [place, setPlace] = useState<StackPlace>()
  useEffect(() => {
    const id = reviewId()
    if (!isConnectedToApp() || id === undefined) return
    loadReviewList()
      .then((reviews) => setPlace(stackPlaceOf(reviews, id)))
      // The strip is a shortcut: without it the report still works, and the list has the stack.
      .catch(() => setPlace(undefined))
  }, [])
  if (place === undefined) return null
  return (
    <nav className="stack-strip" aria-label="Stack">
      <span className="stack-strip-place">
        Stack · {place.position} of {place.size}
      </span>
      {place.below !== undefined && <Neighbour review={place.below} direction={Direction.Below} />}
      {place.above !== undefined && <Neighbour review={place.above} direction={Direction.Above} />}
    </nav>
  )
}

interface NeighbourProps {
  readonly review: ReviewSummary
  readonly direction: Direction
}

function Neighbour({ review, direction }: NeighbourProps): ReactElement {
  const label = `${numberLabel(review.host, review.number)} ${review.title ?? review.displayName}`
  const text = direction === Direction.Below ? `← ${label}` : `${label} →`
  const where = direction === Direction.Below ? "The PR below this one" : "The PR above this one"
  if (!review.hasReport) return <span title={`${where}: no report yet`}>{text}</span>
  return (
    <a href={`/reviews/${review.id}/`} title={where}>
      {text}
    </a>
  )
}
