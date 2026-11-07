import { z } from "zod"
import { reviewerSchema } from "./conversation.ts"
import { commitShaSchema } from "./schema.ts"

export const PullRequestState = { Open: "open", Merged: "merged", Closed: "closed" } as const
export type PullRequestState = (typeof PullRequestState)[keyof typeof PullRequestState]

/** What the host says of a PR now: enough to tell whether its report still describes it. */
export const pullRequestStatusSchema = z.object({
  state: z.enum(PullRequestState),
  headSha: commitShaSchema,
  baseRef: z.string(),
})
export type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>

/** Whether the host could be asked about a member. */
export const MemberCheck = { Checked: "checked", Failed: "failed" } as const
export type MemberCheck = (typeof MemberCheck)[keyof typeof MemberCheck]

export const stackMemberStatusSchema = z.discriminatedUnion("check", [
  z.object({
    check: z.literal(MemberCheck.Checked),
    reviewId: z.number().int().positive(),
    status: pullRequestStatusSchema,
    /**
     * True for an open PR whose report is missing or describes other code: it has new commits,
     * or now merges into another branch, as after the member below it merged.
     */
    needsRefresh: z.boolean(),
    reviewers: z.array(reviewerSchema).readonly(),
  }),
  z.object({
    check: z.literal(MemberCheck.Failed),
    reviewId: z.number().int().positive(),
    /** The host's reason, such as an expired token. */
    error: z.string(),
  }),
])
export type StackMemberStatus = z.infer<typeof stackMemberStatusSchema>

/** A grouped stack as the host has it now. Read when asked for, never stored. */
export const stackViewSchema = z.object({
  id: z.number().int().positive(),
  trunk: z.string(),
  /** Bottom first. */
  members: z.array(stackMemberStatusSchema).readonly(),
})
export type StackView = z.infer<typeof stackViewSchema>
