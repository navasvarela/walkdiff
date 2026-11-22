import { commentableLines, lineNumberOf, previousPathOf, rangeBetween, reviewCommentOnLines, LineSide } from "@walkdiff/review-model"
import type { ChangedFile, LineRange, ReviewComment } from "@walkdiff/review-model"

/** A comment on lines a reviewer picked, as kept in the review record. */
export interface LineComment {
  readonly path: string
  readonly range: LineRange
  readonly text: string
}

// Kept in the same record as change comments, told apart by this prefix. The path comes last, as
// it's the only part that can hold any character.
const KEY_PREFIX = "lines"
const KEY_PATTERN = /^lines:(old|new):(\d+)-(\d+):(.+)$/

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

export function reviewCommentFromLines(comment: LineComment, files: readonly ChangedFile[]): ReviewComment {
  const file = files.find((candidate) => candidate.diff.path === comment.path)
  return reviewCommentOnLines({ path: comment.path, previousPath: file === undefined ? comment.path : previousPathOf(file.diff) }, comment.range, comment.text)
}
