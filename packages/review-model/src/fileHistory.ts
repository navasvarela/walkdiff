import type { CommitSha } from "./schema.ts"

/** One commit that touched a file, as git or a host's API reports it. */
export interface FileCommit {
  readonly sha: string
  /** The first line of its message. */
  readonly subject: string
  /** Whoever wrote it, as an email address or a login; only compared, never shown. */
  readonly author: string
  /** When it was committed, as an ISO 8601 timestamp. */
  readonly committedAt: string
}

export interface FileHistory {
  /** The most recent commits, newest first; hosts return a page, so this can be fewer than `total`. */
  readonly commits: readonly FileCommit[]
  /** How many commits touched the file in the period. */
  readonly total: number
}

export interface FileHistoryRequest {
  readonly paths: readonly string[]
  /** The commit whose history is read: the PR's merge base, so its own commits don't count. */
  readonly until: CommitSha
  /** The start of the period. */
  readonly since: Date
}

/**
 * Reads the recent commits of some files, from local git or from the PR's host. Throws
 * `HistoryUnavailableError` when it can't, such as in a clone without history.
 */
export type FileHistoryReader = (request: FileHistoryRequest) => Promise<ReadonlyMap<string, FileHistory>>

export class HistoryUnavailableError extends Error {
  override readonly name = "HistoryUnavailableError"
}
