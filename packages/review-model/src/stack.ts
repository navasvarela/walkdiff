import { z } from "zod"

/**
 * GitLab shows stacks of up to 20, and Walkdiff keeps to the same limit on both hosts. It bounds
 * the requests one detection makes, and how many analyses accepting one stack can queue.
 */
export const MAX_STACK_SIZE = 20

/** How a stack was found: the host's own stack feature, or Walkdiff following branches. */
export const StackSource = { Host: "host", Branches: "branches" } as const
export type StackSource = (typeof StackSource)[keyof typeof StackSource]

/**
 * An open PR in a stack. It has a number but no URL: the app builds the URL from the PR it was
 * reviewing, so a host's answer can't send it, or the token, to another repository.
 */
export const stackMemberSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  headRef: z.string().min(1),
  /** The branch it merges into, which is the head of the member below it, or the trunk. */
  baseRef: z.string().min(1),
})
export type StackMember = z.infer<typeof stackMemberSchema>

/** Open PRs that build on one another, each based on the one below it. */
export const pullRequestStackSchema = z.object({
  source: z.enum(StackSource),
  /** The branch the bottom member merges into, usually the default branch. */
  trunk: z.string().min(1),
  /** Bottom first. Includes the PR the stack was found from. */
  members: z.array(stackMemberSchema).min(2).max(MAX_STACK_SIZE).readonly(),
  /**
   * PRs that build on the top member side by side. They fork the chain, so they aren't part of
   * it, but a reviewer may still want to know of them.
   */
  leftOut: z.array(stackMemberSchema).max(MAX_STACK_SIZE).readonly(),
})
export type PullRequestStack = z.infer<typeof pullRequestStackSchema>

/** Where a review sits in a stack the reviewer grouped in the app. */
export const stackPlaceSchema = z.object({
  id: z.number().int().positive(),
  /** 1 for the bottom member. */
  position: z.number().int().positive(),
})
export type StackPlace = z.infer<typeof stackPlaceSchema>

/** A stack found from a review that the reviewer hasn't grouped yet, or that has gained PRs since. */
export const stackOfferSchema = pullRequestStackSchema.extend({
  /** The members accepting would add to the review's stack: not in it yet, and not turned down. */
  joining: z.array(z.number().int().positive()).min(1).readonly(),
})
export type StackOffer = z.infer<typeof stackOfferSchema>

/** Accepting an offer. The AI choice applies to the members it adds, since it decides whether their code leaves the machine. */
export const acceptStackRequestSchema = z.object({ ai: z.boolean() })
export type AcceptStackRequest = z.infer<typeof acceptStackRequestSchema>
