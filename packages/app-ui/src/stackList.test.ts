import { describe, expect, it } from "vitest"
import { commitShaSchema } from "@walkdiff/review-model"
import type { ReviewSummary, StackMemberStatus, StackOffer } from "@walkdiff/review-model"
import type { ReviewProgress } from "./progress.ts"
import { approvalCheck, doneState, EntryKind, isWebLink, listEntries, memberStateLabels, newToList, siblingUrl, stackHeadline } from "./stackList.ts"

const HEAD = commitShaSchema.parse("a".repeat(40))

const review = (id: number, stack: { readonly id: number; readonly position: number } | null = null): ReviewSummary => ({
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
  reportHead: { headSha: HEAD, baseRef: "b1" },
  stack,
  stackOffer: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
})

const checked = (reviewId: number, change: Partial<Extract<StackMemberStatus, { check: "checked" }>> = {}): StackMemberStatus => ({
  check: "checked",
  reviewId,
  status: { state: "open", headSha: HEAD, baseRef: "b1" },
  reportChange: "none",
  reviewers: [],
  ...change,
})

describe("the list's entries", () => {
  it("shows a stack once, where its newest member was, with members bottom first", () => {
    const entries = listEntries([review(9), review(5, { id: 1, position: 3 }), review(8), review(3, { id: 1, position: 1 }), review(4, { id: 1, position: 2 })])
    expect(entries.map((entry) => (entry.kind === EntryKind.Review ? entry.review.id : entry.members.map((member) => member.id)))).toEqual([9, [3, 4, 5], 8])
  })
})

describe("offer helpers", () => {
  it("builds a member's address in the review's own project", () => {
    expect(siblingUrl(review(4), 12)).toBe("https://gitlab.com/acme/app/-/merge_requests/12")
  })

  it("counts the members accepting would add as new reviews", () => {
    const offer: StackOffer = { source: "host", trunk: "main", members: [], leftOut: [], joining: [3, 5] }
    expect(newToList(offer, review(4), [review(4), review(3)])).toEqual([5])
  })
})

describe("a member's state", () => {
  it.each([
    ["merged", checked(1, { status: { state: "merged", headSha: HEAD, baseRef: "main" } }), ["Merged"]],
    ["closed", checked(1, { status: { state: "closed", headSha: HEAD, baseRef: "main" } }), ["Closed"]],
    ["up to date with no reviews", checked(1), []],
    ["pushed to", checked(1, { reportChange: "newCommits" }), ["New commits"]],
    ["retargeted", checked(1, { reportChange: "retargeted", status: { state: "open", headSha: HEAD, baseRef: "main" } }), ["Retargeted to main"]],
    [
      "approved and with changes requested",
      checked(1, {
        reviewers: [
          { name: "ana", state: "approved" },
          { name: "bo", state: "changesRequested" },
          { name: "cy", state: "approved" },
        ],
      }),
      ["Approved by ana, cy", "Changes requested by bo"],
    ],
    ["unreachable", { check: "failed", reviewId: 1, error: "Token expired" } satisfies StackMemberStatus, ["Couldn't check: Token expired"]],
  ])("reads %s", (_case, status, texts) => {
    expect(memberStateLabels(status).map((label) => label.text)).toEqual(texts)
  })
})

describe("the stack's headline", () => {
  const members = [review(3), review(4), review(5)]

  it("counts open members, approvals and refreshes", () => {
    const view = {
      id: 1,
      trunk: "main",
      members: [checked(3, { status: { state: "merged", headSha: HEAD, baseRef: "main" } }), checked(4, { reviewers: [{ name: "ana", state: "approved" }] }), checked(5, { reportChange: "newCommits" })],
    }
    expect(stackHeadline(members, view)).toBe("2 PRs · 1 approved · 1 needs a refresh")
  })

  it("counts members before the host has answered", () => {
    expect(stackHeadline(members, undefined)).toBe("3 PRs")
  })
})

describe("done members", () => {
  it.each([
    ["merged", checked(1, { status: { state: "merged", headSha: HEAD, baseRef: "main" } }), "merged"],
    ["open", checked(1), undefined],
    ["unchecked", undefined, undefined],
  ])("reads a %s member", (_case, status, expected) => {
    expect(doneState(status)).toBe(expected)
  })
})

describe("whether a member can be approved with the rest", () => {
  const done: ReviewProgress = { stage: "done", drafts: 0 }

  it.each([
    ["not checked yet", undefined, done, "Still checking"],
    ["unreachable", { check: "failed", reviewId: 1, error: "Token expired" } satisfies StackMemberStatus, done, "Token expired"],
    ["pushed to", checked(1, { reportChange: "newCommits" }), done, "new commits"],
    ["retargeted", checked(1, { reportChange: "retargeted", status: { state: "open", headSha: HEAD, baseRef: "main" } }), done, "merges into main"],
    ["never analyzed", checked(1, { reportChange: "noReport" }), done, "no report"],
  ])("blocks a member %s", (_case, status, progress, blocker) => {
    expect(approvalCheck(status, progress)).toEqual({ ready: false, blocker: expect.stringContaining(blocker) })
  })

  it.each([
    ["fully reviewed", done, []],
    ["with unposted comments", { ...done, drafts: 2 }, ["It has 2 comments you haven't posted. Open it to post them, or approve without them."]],
    ["part reviewed", { stage: "partly", reviewed: 1, total: 4, drafts: 0 } satisfies ReviewProgress, ["You've reviewed 1 of 4 changes."]],
    ["not started", { stage: "notStarted", drafts: 0 } satisfies ReviewProgress, ["You haven't started reviewing it."]],
    ["changed since it was reviewed, with a draft", { stage: "changed", drafts: 1 } satisfies ReviewProgress, ["It has a comment you haven't posted. Open it to post it, or approve without it.", "It changed since you reviewed it. Open it to see what's new."]],
  ])("lets through a member %s, with what to watch for", (_case, progress, warnings) => {
    expect(approvalCheck(checked(1), progress)).toEqual({ ready: true, headSha: HEAD, warnings })
  })

  it.each([
    ["https://gitlab.com/a/-/merge_requests/1#note_1", true],
    ["javascript:alert(1)", false],
  ])("links %s only if it is a web address", (url, expected) => {
    expect(isWebLink(url)).toBe(expected)
  })
})
