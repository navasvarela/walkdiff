import { DiffLineKind, FileContentKind, LineSide } from "@walkdiff/review-model"
import type { ChangedFile, DiffLine, ReviewThread } from "@walkdiff/review-model"

// Enough to recognise the code without opening the file: two lines either side.
const CONTEXT_LINES = 2

/** A line on one side of a file's diff, to scroll to. */
export interface LinePlace {
  readonly side: LineSide
  readonly line: number
}

export interface ContextLine {
  readonly line: DiffLine
  readonly isCommented: boolean
}

/**
 * The diff lines around the line a thread is on, so a reviewer can follow it from the
 * Conversation tab. Undefined when that line isn't in the diff, such as on outdated code.
 */
export function threadContext(files: readonly ChangedFile[], thread: ReviewThread): readonly ContextLine[] | undefined {
  const file = fileOfThread(files, thread)
  if (file === undefined || thread.line === null || file.diff.content.kind !== FileContentKind.Text) return undefined
  for (const hunk of file.diff.content.hunks) {
    const at = hunk.lines.findIndex((line) => lineNumberOn(line, thread.side) === thread.line)
    if (at === -1) continue
    return hunk.lines.slice(Math.max(0, at - CONTEXT_LINES), at + CONTEXT_LINES + 1).map((line) => ({ line, isCommented: line === hunk.lines.at(at) }))
  }
  return undefined
}

/** How many comments each file's threads hold, by the file's path at the head. */
export function commentCountsByPath(files: readonly ChangedFile[], threads: readonly ReviewThread[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const thread of threads) {
    const path = fileOfThread(files, thread)?.diff.path
    if (path !== undefined) counts.set(path, (counts.get(path) ?? 0) + thread.comments.length)
  }
  return counts
}

/** Where to show a thread in the Changes tab: its file's head path, and its line if it has one. */
export function threadTarget(files: readonly ChangedFile[], thread: ReviewThread): { readonly path: string; readonly place: LinePlace | undefined } | undefined {
  const file = fileOfThread(files, thread)
  if (file === undefined) return undefined
  return { path: file.diff.path, place: thread.line === null ? undefined : { side: thread.side, line: thread.line } }
}

// A thread on a removed line of a renamed file names the file's old path.
function fileOfThread(files: readonly ChangedFile[], thread: ReviewThread): ChangedFile | undefined {
  if (thread.path === null) return undefined
  return files.find((file) => file.diff.path === thread.path || ("previousPath" in file.diff && file.diff.previousPath === thread.path))
}

function lineNumberOn(line: DiffLine, side: LineSide): number | undefined {
  if (side === LineSide.Old) return line.kind === DiffLineKind.Added ? undefined : line.oldLine
  return line.kind === DiffLineKind.Removed ? undefined : line.newLine
}
