import { parsePullRequestUrl } from "@walkdiff/providers"
import { commitShaSchema } from "@walkdiff/review-model"
import type { PullRequestStack, PullRequestStatus } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { needsRefresh } from "./stackStatus.ts"
import { canonicalUrl, memberUrl, mergedOrder, stackOfferFor } from "./stacks.ts"

const github = parsePullRequestUrl("https://github.com/acme/app/pull/2/files")
const gitlab = parsePullRequestUrl("https://gitlab.example/group/sub/app/-/merge_requests/2")
const url = (number: number): string => `https://github.com/acme/app/pull/${number}`

const stackOf = (...numbers: number[]): PullRequestStack => ({
  source: "branches",
  trunk: "main",
  members: numbers.map((number, index) => ({ number, title: `PR ${number}`, author: "ana", headRef: `b${number}`, baseRef: index === 0 ? "main" : `b${numbers[index - 1] ?? 0}` })),
  leftOut: [],
})

describe("member URLs", () => {
  it.each([
    [github, "https://github.com/acme/app/pull/2", "https://github.com/acme/app/pull/9"],
    [gitlab, "https://gitlab.example/group/sub/app/-/merge_requests/2", "https://gitlab.example/group/sub/app/-/merge_requests/9"],
  ])("are built from the reviewed PR's own repository", (reviewed, own, member) => {
    expect(canonicalUrl(reviewed)).toBe(own)
    expect(memberUrl(reviewed, 9)).toBe(member)
  })
})

describe("the stack to offer", () => {
  const offer = (grouped: readonly number[], dismissed: readonly number[]): readonly number[] | undefined =>
    stackOfferFor({ reviewed: github, detected: stackOf(1, 2, 3), grouped: new Set(grouped.map(url)), dismissed: new Set(dismissed) })?.joining

  it.each([
    ["a review on its own", [], [], [1, 3]],
    ["a stack missing its new top", [1, 2], [], [3]],
    ["members turned down", [], [1], [3]],
  ])("offers the others for %s", (_case, grouped, dismissed, joining) => {
    expect(offer(grouped, dismissed)).toEqual(joining)
  })

  it.each([
    ["every member is grouped", [1, 2, 3], []],
    ["the rest were turned down", [], [1, 3]],
  ])("offers nothing when %s", (_case, grouped, dismissed) => {
    expect(offer(grouped, dismissed)).toBeUndefined()
  })
})

describe("ordering a stack after a new detection", () => {
  it.each([
    ["a new top", [1, 2, 3], [2, 3, 4], [1, 2, 3, 4]],
    ["the bottom merged", [1, 2, 3], [2, 3], [1, 2, 3]],
    ["a PR inserted in the middle", [1, 3], [1, 2, 3], [1, 2, 3]],
    ["a first grouping", [], [1, 2], [1, 2]],
    ["two members gone from the bottom", [1, 2, 3, 4], [3, 4, 5], [1, 2, 3, 4, 5]],
  ])("keeps every member in place given %s", (_case, previous, detected, expected) => {
    expect(mergedOrder(previous.map(url), detected.map(url))).toEqual(expected.map(url))
  })
})

describe("whether a member needs a refresh", () => {
  const HEAD = commitShaSchema.parse("a".repeat(40))
  const analyzed = { headSha: HEAD, baseRef: "b1" }
  const status = (change: Partial<PullRequestStatus>): PullRequestStatus => ({ state: "open", headSha: HEAD, baseRef: "b1", ...change })

  it.each([
    ["is unchanged", analyzed, status({}), false],
    ["has new commits", analyzed, status({ headSha: commitShaSchema.parse("b".repeat(40)) }), true],
    ["was retargeted after the member below merged", analyzed, status({ baseRef: "main" }), true],
    ["has no report yet", undefined, status({}), true],
    ["is merged, whatever changed", analyzed, status({ state: "merged", baseRef: "main" }), false],
    ["is closed", undefined, status({ state: "closed" }), false],
  ])("says so when it %s", (_case, before, now, expected) => {
    expect(needsRefresh(before, now)).toBe(expected)
  })
})
