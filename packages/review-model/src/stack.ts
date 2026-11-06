import { z } from "zod"

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
  members: z.array(stackMemberSchema).min(2).readonly(),
  /**
   * PRs that build on the top member side by side. They fork the chain, so they aren't part of
   * it, but a reviewer may still want to know of them.
   */
  leftOut: z.array(stackMemberSchema).readonly(),
})
export type PullRequestStack = z.infer<typeof pullRequestStackSchema>
