import { LogLevel } from "@walkdiff/review-model"
import type { Log, LogDetails } from "@walkdiff/review-model"

/** How log lines are printed: plain sentences for people, or JSON Lines for machines. */
export const LogFormat = { Text: "text", Json: "json" } as const
export type LogFormat = (typeof LogFormat)[keyof typeof LogFormat]

export const LOG_FORMAT_VARIABLE = "WALKDIFF_LOG_FORMAT"
const LOG_FORMATS: ReadonlySet<string> = new Set(Object.values(LogFormat))

export function isLogFormat(value: string): value is LogFormat {
  return LOG_FORMATS.has(value)
}

/** Where a log line goes, and the clock that stamps it. */
export interface LogSink {
  readonly write: (line: string) => void
  readonly now: () => Date
}

// A field can't replace these, so every line can be read the same way.
const RESERVED_KEYS: ReadonlySet<string> = new Set(["time", "level", "msg"])

/**
 * In JSON, each line is one object: `time` (ISO 8601, UTC), `level` (info, warn or error) and
 * `msg`, then the event's fields. These names follow common structured-logging practice, so
 * collectors read them without configuration. Text prints only the message, as Walkdiff always has.
 */
export function createLog(format: LogFormat, sink: LogSink): Log {
  if (format === LogFormat.Text) return (message) => sink.write(message)
  return (message, details) => sink.write(jsonLine(message, details, sink.now()))
}

function jsonLine(message: string, details: LogDetails | undefined, time: Date): string {
  const fields = Object.entries(details?.fields ?? {}).filter(([key]) => !RESERVED_KEYS.has(key))
  return JSON.stringify({ time: time.toISOString(), level: details?.level ?? LogLevel.Info, msg: message, ...Object.fromEntries(fields) })
}
