import { DiffLineKind, FileChangeStatus, FileContentKind } from "./schema.ts"
import type { FileDiff } from "./schema.ts"
import { LineSide } from "./conversation.ts"
import type { DiffLineRef, LineRange, ReviewComment } from "./conversation.ts"

/** The lines a host accepts comments on: those in the diff, by number on each side. */
export interface CommentableLines {
  readonly old: ReadonlyMap<number, DiffLineRef>
  readonly new: ReadonlyMap<number, DiffLineRef>
}

export function commentableLines(diff: FileDiff): CommentableLines {
  const old = new Map<number, DiffLineRef>()
  const added = new Map<number, DiffLineRef>()
  if (diff.content.kind === FileContentKind.Binary) return { old, new: added }
  for (const line of diff.content.hunks.flatMap((hunk) => hunk.lines)) {
    if (line.kind === DiffLineKind.Added) added.set(line.newLine, { oldLine: null, newLine: line.newLine })
    else if (line.kind === DiffLineKind.Removed) old.set(line.oldLine, { oldLine: line.oldLine, newLine: null })
    else {
      const ref = { oldLine: line.oldLine, newLine: line.newLine }
      old.set(line.oldLine, ref)
      added.set(line.newLine, ref)
    }
  }
  return { old, new: added }
}

/**
 * The range from one picked line to another, or undefined when any line between them is outside
 * the diff: hosts only take comments on lines they show, and a range can't cross a gap.
 */
export function rangeBetween(lines: CommentableLines, side: LineSide, from: number, to: number): LineRange | undefined {
  const onSide = side === LineSide.Old ? lines.old : lines.new
  const first = Math.min(from, to)
  const last = Math.max(from, to)
  for (let line = first; line <= last; line++) if (!onSide.has(line)) return undefined
  const start = onSide.get(first)
  const end = onSide.get(last)
  return start === undefined || end === undefined ? undefined : { side, start, end }
}

export function lineNumberOf(ref: DiffLineRef, side: LineSide): number {
  return (side === LineSide.Old ? ref.oldLine : ref.newLine) ?? 0
}

export function describeRange({ side, start, end }: LineRange): string {
  const first = lineNumberOf(start, side)
  const last = lineNumberOf(end, side)
  const lines = first === last ? `line ${first}` : `lines ${first}–${last}`
  return side === LineSide.Old ? `${lines} (before)` : lines
}

/** Where a changed file was before the change: its old path when renamed or copied, else its path. */
export function previousPathOf(diff: FileDiff): string {
  return diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? diff.previousPath : diff.path
}

/** The file a line comment is on, by its path now and before the change. GitLab needs both. */
export interface CommentedFile {
  readonly path: string
  readonly previousPath: string
}

/** A comment on lines of a file's diff, as a review posts it. */
export function reviewCommentOnLines(file: CommentedFile, range: LineRange, body: string): ReviewComment {
  return { path: file.path, previousPath: file.previousPath, line: null, label: `${file.path}, ${describeRange(range)}`, range, body }
}
