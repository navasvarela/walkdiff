import { commentableLines, LineSide, previousPathOf } from "@walkdiff/review-model"
import type { FileDiff, ReviewModel, ReviewThread } from "@walkdiff/review-model"
import { FileSide } from "./appClient.ts"

/** A run of consecutive lines, counted from 1, that can take a comment. */
export interface LineBlock {
  readonly first: number
  readonly last: number
}

/** Where a thread or comment sits: a line of one side of a changed file. */
export interface LinePlace {
  /** The file's path at the PR's head. */
  readonly path: string
  /** The path of the document this side is shown in: the old path on the base side of a renamed file. */
  readonly documentPath: string
  readonly side: FileSide
  readonly line: number
}

/** Which side of a diff a document shows, as the review's line ranges count it. */
export function lineSideOf(side: FileSide): LineSide {
  return side === FileSide.Base ? LineSide.Old : LineSide.New
}

/** The changed file a side's document shows: by its head path, or on the base side its old path. */
export function fileShownAt(report: ReviewModel, side: FileSide, documentPath: string): FileDiff | undefined {
  return report.files.map((file) => file.diff).find((diff) => (side === FileSide.Base ? previousPathOf(diff) : diff.path) === documentPath)
}

/**
 * The lines of one side of a file that a host takes comments on: those its diff shows. They come
 * in runs, since hosts don't take a comment across the gap between two hunks.
 */
export function commentableBlocks(diff: FileDiff, side: FileSide): LineBlock[] {
  const lines = commentableLines(diff)
  const numbers = [...(side === FileSide.Base ? lines.old : lines.new).keys()].sort((a, b) => a - b)
  const blocks: LineBlock[] = []
  for (const line of numbers) {
    const last = blocks.at(-1)
    if (last !== undefined && last.last === line - 1) blocks[blocks.length - 1] = { first: last.first, last: line }
    else blocks.push({ first: line, last: line })
  }
  return blocks
}

/**
 * Where a host's thread sits in the review's diff; undefined for one on no line, such as on code
 * that has since changed, which only the report's Conversation tab can show.
 */
export function threadPlace(thread: ReviewThread, report: ReviewModel): LinePlace | undefined {
  if (thread.path === null || thread.line === null) return undefined
  const side = thread.side === LineSide.Old ? FileSide.Base : FileSide.Head
  const diff = report.files.map((file) => file.diff).find((candidate) => candidate.path === thread.path || previousPathOf(candidate) === thread.path)
  if (diff === undefined) return undefined
  return { path: diff.path, documentPath: side === FileSide.Base ? previousPathOf(diff) : diff.path, side, line: thread.line }
}
