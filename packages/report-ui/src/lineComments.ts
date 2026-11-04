import { DiffLineKind, FileChangeStatus, FileContentKind, LineSide } from "@walkdiff/review-model"
import type { ChangedFile, DiffLineRef, FileDiff, LineRange, ReviewComment } from "@walkdiff/review-model"

/** A comment on lines a reviewer picked, as kept in the review record. */
export interface LineComment {
  readonly path: string
  readonly range: LineRange
  readonly text: string
}

/** The lines a host accepts comments on: those in the diff, by number on each side. */
export interface CommentableLines {
  readonly old: ReadonlyMap<number, DiffLineRef>
  readonly new: ReadonlyMap<number, DiffLineRef>
}

// Kept in the same record as change comments, told apart by this prefix. The path comes last, as
// it's the only part that can hold any character.
const KEY_PREFIX = "lines"
const KEY_PATTERN = /^lines:(old|new):(\d+)-(\d+):(.+)$/

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

export function lineCommentKey(path: string, range: LineRange): string {
  return `${KEY_PREFIX}:${range.side}:${lineNumberOf(range.start, range.side)}-${lineNumberOf(range.end, range.side)}:${path}`
}

/**
 * Line comments in the record, rebuilt against the current diff. One whose lines are no longer in
 * the diff, after a new push, is left out rather than posted somewhere it no longer fits.
 */
export function lineCommentsIn(comments: ReadonlyMap<string, string>, files: readonly ChangedFile[]): LineComment[] {
  const byPath = new Map(files.map((file) => [file.diff.path, file]))
  return [...comments].flatMap(([key, text]) => {
    const match = KEY_PATTERN.exec(key)
    if (match === null || text.trim() === "") return []
    const [, side = "", from = "", to = "", path = ""] = match
    const file = byPath.get(path)
    const lineSide = side === LineSide.Old ? LineSide.Old : LineSide.New
    const range = file === undefined ? undefined : rangeBetween(commentableLines(file.diff), lineSide, Number(from), Number(to))
    return range === undefined ? [] : [{ path, range, text: text.trim() }]
  })
}

/** Each line of this file that has a comment, as "side:line", for marking it beside the code. */
export function commentedLinesOf(comments: ReadonlyMap<string, string>, path: string): ReadonlySet<string> {
  const marked = new Set<string>()
  for (const [key, text] of comments) {
    const match = KEY_PATTERN.exec(key)
    if (match === null || match[4] !== path || text.trim() === "") continue
    for (let line = Number(match[2]); line <= Number(match[3]); line++) marked.add(`${match[1]}:${line}`)
  }
  return marked
}

export function describeRange({ side, start, end }: LineRange): string {
  const first = lineNumberOf(start, side)
  const last = lineNumberOf(end, side)
  const lines = first === last ? `line ${first}` : `lines ${first}–${last}`
  return side === LineSide.Old ? `${lines} (before)` : lines
}

export function reviewCommentFromLines(comment: LineComment, files: readonly ChangedFile[]): ReviewComment {
  const file = files.find((candidate) => candidate.diff.path === comment.path)
  const previousPath = file !== undefined && (file.diff.status === FileChangeStatus.Renamed || file.diff.status === FileChangeStatus.Copied) ? file.diff.previousPath : comment.path
  return { path: comment.path, previousPath, line: null, label: `${comment.path}, ${describeRange(comment.range)}`, range: comment.range, body: comment.text }
}
