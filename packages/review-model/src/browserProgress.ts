import { z } from "zod"
import { reportHeadSchema } from "./schema.ts"

const PROGRESS_KEY_PREFIX = "walkdiff-progress:"

/**
 * How far the reviewer got through a report, as the report saves it in the browser for the app's
 * list to show. Both pages are served from the app's origin, so they share the storage; the server
 * never sees it.
 */
export const progressRecordSchema = z
  .object({
    reviewed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** Comments written in the report and not posted yet. Approving from the list would leave them behind. */
    drafts: z.number().int().nonnegative(),
    /** The report these counts come from. After a refresh, the list can't trust them until the new report is opened. */
    head: reportHeadSchema,
  })
  .refine((progress) => progress.reviewed <= progress.total)
export type ProgressRecord = z.infer<typeof progressRecordSchema>

/** Keyed by the PR's URL, which the report and the app's list both have. */
export function progressKey(pullRequestUrl: string): string {
  return `${PROGRESS_KEY_PREFIX}${pullRequestUrl}`
}

/** Undefined for nothing saved, or something this version can't read. */
export function parseProgressRecord(text: string | null): ProgressRecord | undefined {
  if (text === null) return undefined
  try {
    const parsed = progressRecordSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
