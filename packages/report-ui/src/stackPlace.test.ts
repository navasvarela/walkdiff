import { describe, expect, it } from "vitest"
import type { ReviewSummary } from "@walkdiff/review-model"
import { stackPlaceOf } from "./stackPlace.ts"

const review = (id: number, stack: { readonly id: number; readonly position: number } | null): ReviewSummary => ({
  id,
  url: `https://gitlab.com/acme/app/-/merge_requests/${id}`,
  host: "gitlab",
  displayName: `acme/app!${id}`,
  number: id,
  status: "ready",
  step: null,
  error: null,
  hasReport: true,
  ai: false,
  title: `MR ${id}`,
  author: "ana",
  securityLevel: "low",
  unitsToReview: 1,
  untouchedReferences: 0,
  findings: 0,
  coverageSource: null,
  stack,
  stackOffer: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
})

// Listed newest first, as the app lists them, and with another stack mixed in.
const reviews = [review(5, { id: 1, position: 3 }), review(9, { id: 2, position: 1 }), review(3, { id: 1, position: 1 }), review(4, { id: 1, position: 2 }), review(8, null)]

describe("a report's place in its stack", () => {
  it.each([
    [3, 1, undefined, 4],
    [4, 2, 3, 5],
    [5, 3, 4, undefined],
  ])("places review %i at %i, between %s and %s", (id, position, below, above) => {
    expect(stackPlaceOf(reviews, id)).toMatchObject({ position, size: 3, below: below === undefined ? undefined : { id: below }, above: above === undefined ? undefined : { id: above } })
  })

  it.each([
    ["isn't in a stack", 8],
    ["isn't on the list", 99],
  ])("is nowhere when the review %s", (_case, id) => {
    expect(stackPlaceOf(reviews, id)).toBeUndefined()
  })
})
