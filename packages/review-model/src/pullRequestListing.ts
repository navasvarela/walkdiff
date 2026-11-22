import { z } from "zod"
import { GitHostKind } from "./schema.ts"

/**
 * An open PR or MR as a list shows it, before anything is analyzed: enough to pick one and add it
 * to the app by its `url`.
 */
export const pullRequestListingSchema = z.object({
  url: z.url(),
  host: z.enum(GitHostKind),
  /** `owner/repo#12` or `group/project!12`. */
  displayName: z.string(),
  /** `owner/repo` or `group/subgroup/project`. */
  repository: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  draft: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type PullRequestListing = z.infer<typeof pullRequestListingSchema>
