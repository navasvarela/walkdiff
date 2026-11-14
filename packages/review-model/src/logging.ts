export const LogLevel = { Info: "info", Warn: "warn", Error: "error" } as const
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

/** Facts about an event that a log collector can filter on, such as a report's folder or a step. */
export type LogFields = Readonly<Record<string, string | number | boolean>>

export interface LogDetails {
  /** Info when left out. */
  readonly level?: LogLevel
  readonly fields?: LogFields
}

/**
 * How Walkdiff reports what it's doing. The CLI prints each message as plain text for people, or
 * as a JSON line for CI and log collectors. A function of the message alone fits, which keeps a
 * test's `(message) => logged.push(message)` working.
 */
export type Log = (message: string, details?: LogDetails) => void
