import { z } from "zod"

/**
 * How a report page talks to an editor that shows it, such as the VS Code extension's panel. The
 * page has no key and makes no network calls there: it posts these messages, and the editor calls
 * the app for it and answers. Both sides check every message against these schemas.
 */

/** A meta tag the editor adds, naming how the page reaches the app. */
export const REPORT_TRANSPORT_META = "walkdiff-transport"
export const ReportTransport = { Editor: "editor" } as const

/** The id of the script element holding the page's saved progress, as the editor last stored it. */
export const REPORT_SAVED_STATE_ELEMENT_ID = "walkdiff-saved-state"

export const ReportRequestMethod = { Get: "GET", Post: "POST" } as const
export type ReportRequestMethod = (typeof ReportRequestMethod)[keyof typeof ReportRequestMethod]

// Saved progress holds comment drafts, which run to a few kilobytes; this leaves ample room.
const MAX_SAVED_VALUE_CHARS = 2_000_000
const MAX_KEY_CHARS = 1_000

export const reportMessageSchema = z.discriminatedUnion("type", [
  /** An app API call, by its path from `/api/`, which the editor makes with its key. */
  z.object({ type: z.literal("request"), id: z.number().int().nonnegative(), method: z.enum(ReportRequestMethod), path: z.string().startsWith("/api/"), body: z.unknown().optional() }),
  /** The page's progress on this review, for the editor to keep and hand back next time. */
  z.object({ type: z.literal("save"), key: z.string().min(1).max(MAX_KEY_CHARS), value: z.string().max(MAX_SAVED_VALUE_CHARS) }),
  /** A link to another review in the app, such as the next PR in a stack. */
  z.object({ type: z.literal("openReview"), reviewId: z.number().int().positive() }),
])
export type ReportMessage = z.infer<typeof reportMessageSchema>

/** The editor's answer to a request: the app's status and JSON body, as the page would have had them. */
export const reportReplySchema = z.object({ type: z.literal("response"), id: z.number().int().nonnegative(), status: z.number().int(), body: z.unknown() })
export type ReportReply = z.infer<typeof reportReplySchema>

export const savedReportStateSchema = z.record(z.string(), z.string())
