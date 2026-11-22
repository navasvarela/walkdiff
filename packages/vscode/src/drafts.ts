import { commentableLines, describeRange, lineNumberOf, lineRangeSchema, previousPathOf, rangeBetween, reviewCommentOnLines } from "@walkdiff/review-model"
import type { LineRange, LineSide, ReviewComment, ReviewModel } from "@walkdiff/review-model"
import { z } from "zod"

/** A comment the reviewer wrote on lines of a file, kept until they submit the review. */
export interface Draft {
  readonly id: string
  /** The file's path at the PR's head, even for a comment on its old lines. */
  readonly path: string
  readonly range: LineRange
  readonly body: string
}

const draftSchema = z.object({ id: z.string().min(1), path: z.string().min(1), range: lineRangeSchema, body: z.string() })
const storedDraftsSchema = z.array(draftSchema)

/** Where drafts are kept: VS Code's workspace storage, which survives restarts. */
export interface DraftStorage {
  get(key: string): unknown
  update(key: string, value: unknown): PromiseLike<void>
}

const KEY_PREFIX = "walkdiff.drafts."

/**
 * Each review's draft comments. They are kept by the review's PR link rather than its id in the
 * app, so they survive the review being removed and added again.
 */
export class DraftStore {
  readonly #storage: DraftStorage
  #nextId = Date.now()

  constructor(storage: DraftStorage) {
    this.#storage = storage
  }

  /** The review's drafts; ones stored by an older version, in a shape this one can't read, are dropped. */
  list(reviewUrl: string): readonly Draft[] {
    return storedDraftsSchema.safeParse(this.#storage.get(KEY_PREFIX + reviewUrl)).data ?? []
  }

  async add(reviewUrl: string, path: string, range: LineRange, body: string): Promise<Draft> {
    const draft = { id: String(this.#nextId++), path, range, body }
    await this.#save(reviewUrl, [...this.list(reviewUrl), draft])
    return draft
  }

  async edit(reviewUrl: string, id: string, body: string): Promise<void> {
    await this.#save(reviewUrl, this.list(reviewUrl).map((draft) => (draft.id === id ? { ...draft, body } : draft)))
  }

  async remove(reviewUrl: string, id: string): Promise<void> {
    await this.#save(reviewUrl, this.list(reviewUrl).filter((draft) => draft.id !== id))
  }

  async clear(reviewUrl: string): Promise<void> {
    await this.#storage.update(KEY_PREFIX + reviewUrl, undefined)
  }

  async #save(reviewUrl: string, drafts: readonly Draft[]): Promise<void> {
    await this.#storage.update(KEY_PREFIX + reviewUrl, drafts.length === 0 ? undefined : drafts)
  }
}

/**
 * The drafts as the review posts them, placed on lines of the report's diff. A draft whose lines
 * are no longer in the diff, after new commits, isn't lost: it goes in the review's text instead,
 * naming the lines it was written on.
 */
export function reviewCommentsFrom(drafts: readonly Draft[], report: ReviewModel): ReviewComment[] {
  return drafts
    .filter((draft) => draft.body.trim() !== "")
    .map((draft) => {
      const diff = report.files.find((file) => file.diff.path === draft.path)?.diff
      const file = { path: draft.path, previousPath: diff === undefined ? draft.path : previousPathOf(diff) }
      const { side, start, end } = draft.range
      const range = diff === undefined ? undefined : rangeBetween(commentableLines(diff), side, lineNumberOf(start, side), lineNumberOf(end, side))
      if (range !== undefined) return reviewCommentOnLines(file, range, draft.body.trim())
      return { ...file, line: null, label: `${draft.path}, ${describeRange(draft.range)}`, range: null, body: draft.body.trim() }
    })
}

/** The range of lines a new comment covers, on one side, or undefined when they aren't all in the diff. */
export function draftRange(report: ReviewModel, path: string, side: LineSide, firstLine: number, lastLine: number): LineRange | undefined {
  const diff = report.files.find((file) => file.diff.path === path)?.diff
  return diff === undefined ? undefined : rangeBetween(commentableLines(diff), side, firstLine, lastLine)
}
