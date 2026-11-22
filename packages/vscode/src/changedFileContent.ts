import * as vscode from "vscode"
import { FileSide } from "./appClient.ts"
import type { AppSession } from "./appSession.ts"

/** The scheme of a changed file's text at one side of a review, as `walkdiff:/<path>?review=<id>&side=base`. */
export const CHANGED_FILE_SCHEME = "walkdiff"

export function changedFileUri(reviewId: number, side: FileSide, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CHANGED_FILE_SCHEME, path: `/${path}`, query: new URLSearchParams({ review: String(reviewId), side }).toString() })
}

function isFileSide(value: string | null): value is FileSide {
  return value === FileSide.Base || value === FileSide.Head
}

/** One side of a review's changed file, as a `walkdiff:` document shows it. */
export interface ChangedFileRef {
  readonly reviewId: number
  readonly side: FileSide
  /** The file's path at that side: its old path on the base side of a renamed file. */
  readonly path: string
}

export function parseChangedFileUri(uri: vscode.Uri): ChangedFileRef | undefined {
  if (uri.scheme !== CHANGED_FILE_SCHEME) return undefined
  const query = new URLSearchParams(uri.query)
  const reviewId = Number(query.get("review"))
  const side = query.get("side")
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0 || !isFileSide(side)) return undefined
  return { reviewId, side, path: uri.path.slice(1) }
}

/**
 * Serves changed files from the app, so a PR can be read in VS Code's diff editor without being
 * checked out. A file that doesn't exist at a side, such as an added file at base, reads as empty.
 */
export class ChangedFileContent implements vscode.TextDocumentContentProvider {
  readonly #session: AppSession

  constructor(session: AppSession) {
    this.#session = session
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const file = parseChangedFileUri(uri)
    if (file === undefined) return ""
    const client = await this.#session.client()
    return (await client.file(file.reviewId, file.side, file.path)) ?? ""
  }
}
