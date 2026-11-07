import { MAX_STACK_SIZE, StackSource } from "@walkdiff/review-model"
import type { PullRequestStack, StackMember } from "@walkdiff/review-model"

/** An open PR as the walk sees it. */
export interface StackCandidate {
  readonly member: StackMember
  /** False for a PR from a fork: its head branch isn't in this repository, so no PR here can build on it. */
  readonly headInRepository: boolean
}

/** A repository's open PRs, looked up by branch. */
export interface OpenPullRequests {
  withHead(branch: string): Promise<readonly StackCandidate[]>
  withBase(branch: string): Promise<readonly StackCandidate[]>
}

export interface StackWalkStart {
  readonly pullRequest: StackCandidate
  /** Where walking down stops: a PR into the default branch is the bottom, even if PRs come from it. */
  readonly defaultBranch: string
}

/**
 * Finds a stack by following branches, for hosts or repositories without stacks of their own.
 * Walks down through the open PR whose head is each base, then up through the open PR based on
 * each head. Wherever the chain is ambiguous it stops, since a stack is one line of PRs.
 */
export async function walkStack(start: StackWalkStart, open: OpenPullRequests): Promise<PullRequestStack | undefined> {
  const reviewed = start.pullRequest.member
  const seen = new Set([reviewed.number])
  const below = await membersBelow(start, open, seen)
  const above = await membersAbove(start.pullRequest, open, seen, MAX_STACK_SIZE - below.length - 1)
  const members = [...below, reviewed, ...above.members]
  if (members.length < 2) return undefined
  return { source: StackSource.Branches, trunk: below.at(0)?.baseRef ?? reviewed.baseRef, members, leftOut: above.leftOut }
}

async function membersBelow(start: StackWalkStart, open: OpenPullRequests, seen: Set<number>): Promise<StackMember[]> {
  const below: StackMember[] = []
  let base = start.pullRequest.member.baseRef
  while (base !== start.defaultBranch && below.length < MAX_STACK_SIZE - 1) {
    const [parent, ...others] = (await open.withHead(base)).filter((candidate) => candidate.headInRepository && !seen.has(candidate.member.number))
    // Two open PRs from one branch, into different bases, leave no single PR below.
    if (parent === undefined || others.length > 0) break
    seen.add(parent.member.number)
    below.unshift(parent.member)
    base = parent.member.baseRef
  }
  return below
}

interface MembersAbove {
  readonly members: readonly StackMember[]
  readonly leftOut: readonly StackMember[]
}

async function membersAbove(start: StackCandidate, open: OpenPullRequests, seen: Set<number>, room: number): Promise<MembersAbove> {
  const members: StackMember[] = []
  let top = start
  while (top.headInRepository && members.length < room) {
    const children = (await open.withBase(top.member.headRef)).filter((candidate) => !seen.has(candidate.member.number))
    const [child, ...others] = children
    if (child === undefined) break
    if (others.length > 0) return { members, leftOut: children.slice(0, MAX_STACK_SIZE).map((candidate) => candidate.member) }
    seen.add(child.member.number)
    members.push(child.member)
    top = child
  }
  return { members, leftOut: [] }
}

/**
 * A stack from the host's own feature, bottom first. A longer one than Walkdiff takes is cut to
 * the members around the reviewed PR, so that one stays in it.
 */
export function stackFromHost(ordered: readonly StackMember[], reviewed: number): PullRequestStack | undefined {
  const members = keptAround(ordered, ordered.findIndex((member) => member.number === reviewed))
  const bottom = members.at(0)
  return bottom === undefined || members.length < 2 ? undefined : { source: StackSource.Host, trunk: bottom.baseRef, members, leftOut: [] }
}

/** The members of a host's stack Walkdiff takes: all of them, or the limit's worth centred on `index`. Empty when `index` is -1. */
export function keptAround<T>(ordered: readonly T[], index: number): T[] {
  if (index === -1) return []
  const first = Math.max(0, Math.min(index - Math.floor(MAX_STACK_SIZE / 2), ordered.length - MAX_STACK_SIZE))
  return ordered.slice(first, first + MAX_STACK_SIZE)
}

/**
 * Puts members in stack order, bottom first, by following each one's head to the member based
 * on it. Undefined when they don't form a single chain. Used where a host's own order isn't
 * reliable: GitLab documents its stack as top first and without the MR itself, and gitlab.com
 * answered bottom first and with it.
 */
export function inStackOrder(members: readonly StackMember[]): StackMember[] | undefined {
  const distinct = [...new Map(members.map((member) => [member.number, member])).values()]
  const heads = new Set(distinct.map((member) => member.headRef))
  const [bottom, ...otherBottoms] = distinct.filter((member) => !heads.has(member.baseRef))
  if (bottom === undefined || otherBottoms.length > 0) return undefined
  const ordered = [bottom]
  for (let top = bottom; ordered.length < distinct.length; ) {
    const [next, ...others] = distinct.filter((member) => member.baseRef === top.headRef)
    if (next === undefined || others.length > 0 || ordered.includes(next)) return undefined
    ordered.push(next)
    top = next
  }
  return ordered
}
