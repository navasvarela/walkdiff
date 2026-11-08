import type { ReviewSummary } from "@walkdiff/review-model"

/** Where this report's PR sits in a stack grouped in the app, with the PRs either side of it. */
export interface StackPlace {
  /** 1 for the bottom member. */
  readonly position: number
  readonly size: number
  readonly below: ReviewSummary | undefined
  readonly above: ReviewSummary | undefined
}

/** Undefined when the review isn't in a stack, or isn't on the list any more. */
export function stackPlaceOf(reviews: readonly ReviewSummary[], reviewId: number): StackPlace | undefined {
  const stackId = reviews.find((review) => review.id === reviewId)?.stack?.id
  if (stackId === undefined) return undefined
  const members = reviews.filter((review) => review.stack?.id === stackId).toSorted((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0))
  const index = members.findIndex((review) => review.id === reviewId)
  return { position: index + 1, size: members.length, below: members[index - 1], above: members[index + 1] }
}
