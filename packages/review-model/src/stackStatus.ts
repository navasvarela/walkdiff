import { z } from "zod"
import { reviewerSchema } from "./conversation.ts"
import { commitShaSchema, GitHostKind } from "./schema.ts"

export const PullRequestState = { Open: "open", Merged: "merged", Closed: "closed" } as const
export type PullRequestState = (typeof PullRequestState)[keyof typeof PullRequestState]

/** What the host says of a PR now: enough to tell whether its report still describes it. */
export const pullRequestStatusSchema = z.object({
  state: z.enum(PullRequestState),
  headSha: commitShaSchema,
  baseRef: z.string(),
})
export type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>

/** Why a member's report no longer describes it, if it doesn't. */
export const ReportChange = {
  None: "none",
  /** It was never analyzed successfully. */
  NoReport: "noReport",
  NewCommits: "newCommits",
  /** It merges into another branch now, as after the member below it merged, so its diff runs from a different base. */
  Retargeted: "retargeted",
} as const
export type ReportChange = (typeof ReportChange)[keyof typeof ReportChange]

/** Whether the host could be asked about a member. */
export const MemberCheck = { Checked: "checked", Failed: "failed" } as const
export type MemberCheck = (typeof MemberCheck)[keyof typeof MemberCheck]

export const stackMemberStatusSchema = z.discriminatedUnion("check", [
  z.object({
    check: z.literal(MemberCheck.Checked),
    reviewId: z.number().int().positive(),
    status: pullRequestStatusSchema,
    /** Always `none` for a merged or closed PR, whose report no longer matters. */
    reportChange: z.enum(ReportChange),
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

/** How each host writes a PR's number in text: `#12` on GitHub, `!12` on GitLab. */
export function numberLabel(host: GitHostKind, number: number): string {
  return `${host === GitHostKind.GitHub ? "#" : "!"}${number}`
}
