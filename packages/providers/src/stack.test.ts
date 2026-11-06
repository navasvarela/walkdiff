import { describe, expect, it } from "vitest"
import { MAX_STACK_SIZE } from "@walkdiff/review-model"
import type { StackMember } from "@walkdiff/review-model"
import { inStackOrder, stackFromHost, walkStack } from "./stack.ts"
import type { OpenPullRequests, StackCandidate } from "./stack.ts"

const member = (number: number, baseRef: string, headRef = `b${number}`): StackMember => ({ number, title: `PR ${number}`, author: "ana", headRef, baseRef })
const local = (number: number, baseRef: string, headRef?: string): StackCandidate => ({ member: member(number, baseRef, headRef), headInRepository: true })
const fromFork = (number: number, baseRef: string, headRef?: string): StackCandidate => ({ member: member(number, baseRef, headRef), headInRepository: false })

/** Answers like a host would, from every open PR in the repository. */
function openPullRequests(all: readonly StackCandidate[]): OpenPullRequests {
  return {
    withHead: (branch) => Promise.resolve(all.filter((candidate) => candidate.member.headRef === branch)),
    withBase: (branch) => Promise.resolve(all.filter((candidate) => candidate.member.baseRef === branch)),
  }
}

/** A chain of `count` local PRs numbered from 1, the first into main. */
function chain(count: number): StackCandidate[] {
  return Array.from({ length: count }, (_, index) => local(index + 1, index === 0 ? "main" : `b${index}`))
}

async function walkFrom(number: number, all: readonly StackCandidate[]): Promise<{ readonly members: readonly number[]; readonly leftOut: readonly number[]; readonly trunk: string } | undefined> {
  const start = all.find((candidate) => candidate.member.number === number)
  if (start === undefined) throw new Error(`No PR ${number} in the fixture`)
  const stack = await walkStack({ pullRequest: start, defaultBranch: "main" }, openPullRequests(all))
  return stack === undefined ? undefined : { members: stack.members.map((found) => found.number), leftOut: stack.leftOut.map((found) => found.number), trunk: stack.trunk }
}

describe("walking branches", () => {
  it.each([
    ["the bottom", 1],
    ["the middle", 2],
    ["the top", 3],
  ])("finds the whole chain from %s, bottom first", async (_where, start) => {
    expect(await walkFrom(start, chain(3))).toEqual({ members: [1, 2, 3], leftOut: [], trunk: "main" })
  })

  it("finds nothing for a PR on its own", async () => {
    expect(await walkFrom(1, [local(1, "main"), local(2, "main")])).toBeUndefined()
  })

  it("stops at a fork in the chain, and names the PRs left out", async () => {
    const all = [...chain(2), local(3, "b2"), local(4, "b2")]
    expect(await walkFrom(1, all)).toEqual({ members: [1, 2], leftOut: [3, 4], trunk: "main" })
  })

  it("finds nothing when the only PRs above fork straight away", async () => {
    expect(await walkFrom(1, [local(1, "main"), local(2, "b1"), local(3, "b1")])).toBeUndefined()
  })

  it("stops going down where two PRs come from the same branch", async () => {
    const all = [local(1, "main"), local(9, "release", "b1"), local(2, "b1")]
    expect(await walkFrom(2, all)).toBeUndefined()
  })

  it("stops at the default branch, though a PR comes from it", async () => {
    const all = [local(9, "release", "main"), local(1, "main"), local(2, "b1")]
    expect(await walkFrom(2, all)).toEqual({ members: [1, 2], leftOut: [], trunk: "main" })
  })

  it("stacks on a branch other than the default one", async () => {
    const all = [local(1, "release"), local(2, "b1")]
    expect(await walkFrom(2, all)).toEqual({ members: [1, 2], leftOut: [], trunk: "release" })
  })

  it("takes a fork's PR as the top, but nothing above it, and never as a member below", async () => {
    // b2 in this repository is unrelated to the fork's b2, which PR 3 can't be based on.
    const all = [local(1, "main"), fromFork(2, "b1"), local(3, "b2")]
    expect(await walkFrom(1, all)).toEqual({ members: [1, 2], leftOut: [], trunk: "main" })
    expect(await walkFrom(3, all)).toBeUndefined()
  })

  it("stops on a loop of branches", async () => {
    const all = [local(1, "b2"), local(2, "b1")]
    expect(await walkFrom(1, all)).toEqual({ members: [2, 1], leftOut: [], trunk: "b1" })
  })

  it("keeps to the size limit, from the middle of a long chain", async () => {
    const found = await walkFrom(15, chain(MAX_STACK_SIZE + 10))
    expect(found?.members).toHaveLength(MAX_STACK_SIZE)
    expect(found?.members.at(0)).toBe(1)
    expect(found?.members).toContain(15)
  })
})

describe("a host's own stack", () => {
  const ordered = (count: number): StackMember[] => chain(count).map((candidate) => candidate.member)

  it("keeps the host's order and takes the bottom's base as the trunk", () => {
    expect(stackFromHost(ordered(3), 2)).toMatchObject({ source: "host", trunk: "main", members: [{ number: 1 }, { number: 2 }, { number: 3 }], leftOut: [] })
  })

  it.each([
    ["one member", ordered(1), 1],
    ["no reviewed PR among them", ordered(3), 7],
  ])("is no stack with %s", (_case, members, reviewed) => {
    expect(stackFromHost(members, reviewed)).toBeUndefined()
  })

  it.each([1, 50, 100])("cuts a long stack to the members around PR %i", (reviewed) => {
    const stack = stackFromHost(ordered(100), reviewed)
    expect(stack?.members).toHaveLength(MAX_STACK_SIZE)
    expect(stack?.members.map((found) => found.number)).toContain(reviewed)
  })
})

describe("putting members in stack order", () => {
  it.each([
    ["shuffled", [member(3, "b2"), member(1, "main"), member(2, "b1")], [1, 2, 3]],
    ["with the same PR twice", [member(2, "b1"), member(1, "main"), member(2, "b1")], [1, 2]],
  ])("orders members given %s", (_case, members, expected) => {
    expect(inStackOrder(members)?.map((found) => found.number)).toEqual(expected)
  })

  it.each([
    ["two bottoms", [member(1, "main"), member(2, "main")]],
    ["a fork", [member(1, "main"), member(2, "b1"), member(3, "b1")]],
    ["a gap", [member(1, "main"), member(3, "b2")]],
    ["a loop", [member(1, "b2"), member(2, "b1")]],
  ])("gives up on %s", (_case, members) => {
    expect(inStackOrder(members)).toBeUndefined()
  })
})
