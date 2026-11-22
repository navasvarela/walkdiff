import { lineNumberOf, previousPathOf, ReviewEvent } from "@walkdiff/review-model"
import type { LineRange, ReviewModel, ReviewThread } from "@walkdiff/review-model"
import * as vscode from "vscode"
import { AppRequestError, FileSide } from "./appClient.ts"
import type { AppSession } from "./appSession.ts"
import { changedFileUri, parseChangedFileUri } from "./changedFileContent.ts"
import type { ChangedFileRef } from "./changedFileContent.ts"
import { commentableBlocks, fileShownAt, lineSideOf, threadPlace } from "./commentPlaces.ts"
import { draftRange, reviewCommentsFrom } from "./drafts.ts"
import type { Draft, DraftStore } from "./drafts.ts"
import { draftKeyOf } from "./reportCache.ts"
import type { ReportCache } from "./reportCache.ts"
import { CancelledError, UserFacingError } from "./userFacingError.ts"

const CONTROLLER_ID = "walkdiff"
/** Thread and comment context values, matched by the menus in package.json. */
const DRAFT = "draft"
const HOST_OPEN = "host.open"
const HOST_RESOLVED = "host.resolved"
const HOST_COMMENT = "host"
const PENDING_LABEL = "Pending: posted when you submit the review"
const OPEN_CHOICE = "Open"

interface Verdict extends vscode.QuickPickItem {
  readonly event: ReviewEvent
}

const VERDICTS: readonly Verdict[] = [
  { label: "Comment", detail: "Post your comments without a verdict", event: ReviewEvent.Comment },
  { label: "Approve", detail: "Approve the pull request", event: ReviewEvent.Approve },
  { label: "Request changes", detail: "Ask for changes before it's merged", event: ReviewEvent.RequestChanges },
]

/** A draft as the editor shows it, in a thread on its lines. */
export class DraftComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview
  readonly author: vscode.CommentAuthorInformation = { name: "You" }
  readonly label = "Pending"
  readonly contextValue = DRAFT
  body: string | vscode.MarkdownString
  /** The text as last saved, which cancelling an edit puts back. */
  savedBody: string
  readonly draft: Draft
  readonly thread: vscode.CommentThread

  constructor(draft: Draft, thread: vscode.CommentThread) {
    this.draft = draft
    this.thread = thread
    this.body = draft.body
    this.savedBody = draft.body
  }
}

/** What a thread in the editor stands for. */
type ThreadOrigin = { readonly kind: "draft"; readonly reviewId: number } | { readonly kind: "host"; readonly reviewId: number; readonly threadId: string }

/**
 * Comments in the diff editor: the reviewer's drafts, kept until they submit the review, and the
 * PR's threads from its host, which they can reply to and resolve.
 */
export class ReviewComments implements vscode.Disposable {
  readonly #session: AppSession
  readonly #reports: ReportCache
  readonly #drafts: DraftStore
  readonly #controller = vscode.comments.createCommentController(CONTROLLER_ID, "Walkdiff")
  readonly #origins = new WeakMap<vscode.CommentThread, ThreadOrigin>()
  /** The threads shown for each review, so they can be replaced when the review or its conversation changes. */
  readonly #shown = new Map<number, vscode.CommentThread[]>()
  readonly #loading = new Map<number, Promise<void>>()

  constructor(session: AppSession, reports: ReportCache, drafts: DraftStore) {
    this.#session = session
    this.#reports = reports
    this.#drafts = drafts
    this.#controller.options = { prompt: "Add a comment to your review", placeHolder: "Comments are posted together when you submit the review." }
    this.#controller.commentingRangeProvider = { provideCommentingRanges: (document) => this.#commentingRanges(document) }
  }

  dispose(): void {
    this.#controller.dispose()
  }

  /** Shows a review's drafts and threads the first time one of its files is opened. */
  async show(document: vscode.TextDocument): Promise<void> {
    const file = parseChangedFileUri(document.uri)
    if (file === undefined || this.#shown.has(file.reviewId)) return
    await this.reload(file.reviewId)
  }

  /** Replaces a review's threads with its drafts and the host's threads as they are now. */
  async reload(reviewId: number): Promise<void> {
    const loading = this.#loading.get(reviewId) ?? this.#load(reviewId).finally(() => this.#loading.delete(reviewId))
    this.#loading.set(reviewId, loading)
    await loading
  }

  async addDraft(reply: vscode.CommentReply): Promise<void> {
    const { thread, text } = reply
    const file = parseChangedFileUri(thread.uri)
    if (file === undefined || thread.range === undefined || text.trim() === "") return
    const report = await this.#reports.latest(file.reviewId)
    const diff = fileShownAt(report, file.side, file.path)
    const range = diff === undefined ? undefined : draftRange(report, diff.path, lineSideOf(file.side), thread.range.start.line + 1, thread.range.end.line + 1)
    if (diff === undefined || range === undefined) throw new UserFacingError("A comment can only go on lines the diff shows, within one of its hunks.")
    const draft = await this.#drafts.add(draftKeyOf(report, file.reviewId), diff.path, range, text.trim())
    this.#markAsDraft(thread, file.reviewId)
    thread.comments = [...thread.comments, new DraftComment(draft, thread)]
  }

  async replyToThread(reply: vscode.CommentReply): Promise<void> {
    const origin = this.#origins.get(reply.thread)
    if (origin?.kind !== "host" || reply.text.trim() === "") return
    await (await this.#session.client()).reply(origin.reviewId, origin.threadId, reply.text.trim())
    await this.reload(origin.reviewId)
  }

  async setResolved(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const origin = this.#origins.get(thread)
    if (origin?.kind !== "host") return
    await (await this.#session.client()).setResolved(origin.reviewId, origin.threadId, resolved)
    await this.reload(origin.reviewId)
  }

  editDraft(comment: DraftComment): void {
    comment.mode = vscode.CommentMode.Editing
    refresh(comment.thread)
  }

  async saveDraft(comment: DraftComment): Promise<void> {
    const body = typeof comment.body === "string" ? comment.body : comment.body.value
    const report = await this.#reports.latest(this.#reviewIdOf(comment.thread))
    await this.#drafts.edit(draftKeyOf(report, this.#reviewIdOf(comment.thread)), comment.draft.id, body)
    comment.savedBody = body
    comment.mode = vscode.CommentMode.Preview
    refresh(comment.thread)
  }

  cancelDraftEdit(comment: DraftComment): void {
    comment.body = comment.savedBody
    comment.mode = vscode.CommentMode.Preview
    refresh(comment.thread)
  }

  async deleteDraft(comment: DraftComment): Promise<void> {
    const reviewId = this.#reviewIdOf(comment.thread)
    await this.#drafts.remove(draftKeyOf(await this.#reports.latest(reviewId), reviewId), comment.draft.id)
    comment.thread.comments = comment.thread.comments.filter((other) => other !== comment)
    if (comment.thread.comments.length === 0) comment.thread.dispose()
  }

  /**
   * Posts the review with the reviewer's drafts and verdict. It speaks for the commit the report
   * was made from, so the app refuses it if the PR has moved on since.
   */
  async submit(reviewId: number): Promise<void> {
    const report = await this.#reports.latest(reviewId)
    const key = draftKeyOf(report, reviewId)
    const comments = reviewCommentsFrom(this.#drafts.list(key), report)
    const verdict = await vscode.window.showQuickPick(VERDICTS, { title: submitTitle(comments.length, comments.filter((comment) => comment.range === null).length) })
    if (verdict === undefined) throw new CancelledError()
    const body = await vscode.window.showInputBox({
      title: verdict.label,
      prompt: "A summary for the review",
      validateInput: (value) => (needsBody(verdict.event, comments.length) && value.trim() === "" ? "Say what you think of the change" : undefined),
    })
    if (body === undefined) throw new CancelledError()
    const posted = await (await this.#session.client()).submit(reviewId, { event: verdict.event, body: body.trim(), headSha: report.pullRequest.headSha, comments })
    await this.#drafts.clear(key)
    await this.reload(reviewId)
    const choice = await vscode.window.showInformationMessage("Your review is posted.", OPEN_CHOICE)
    if (choice === OPEN_CHOICE) await vscode.env.openExternal(vscode.Uri.parse(posted.url))
  }

  async #commentingRanges(document: vscode.TextDocument): Promise<vscode.Range[]> {
    const file = parseChangedFileUri(document.uri)
    if (file === undefined) return []
    const diff = fileShownAt(await this.#reports.latest(file.reviewId), file.side, file.path)
    return diff === undefined ? [] : commentableBlocks(diff, file.side).map((block) => new vscode.Range(block.first - 1, 0, block.last - 1, 0))
  }

  async #load(reviewId: number): Promise<void> {
    const report = await this.#reports.latest(reviewId)
    const threads = [...this.#draftThreads(reviewId, report), ...this.#hostThreads(reviewId, report, await this.#conversationThreads(reviewId))]
    for (const thread of this.#shown.get(reviewId) ?? []) thread.dispose()
    this.#shown.set(reviewId, threads)
  }

  /** The host's threads; none when the host can't be read, which the reviewer is told once. */
  async #conversationThreads(reviewId: number): Promise<readonly ReviewThread[]> {
    try {
      return (await (await this.#session.client()).conversation(reviewId)).threads
    } catch (error: unknown) {
      if (!(error instanceof AppRequestError)) throw error
      void vscode.window.showWarningMessage(`Walkdiff couldn't read the pull request's comments: ${error.message}`)
      return []
    }
  }

  #draftThreads(reviewId: number, report: ReviewModel): vscode.CommentThread[] {
    const byPlace = new Map<string, Draft[]>()
    for (const draft of this.#drafts.list(draftKeyOf(report, reviewId))) {
      const place = `${draft.path}\n${JSON.stringify(draft.range)}`
      byPlace.set(place, [...(byPlace.get(place) ?? []), draft])
    }
    return [...byPlace.values()].flatMap((drafts) => {
      const [first] = drafts
      if (first === undefined) return []
      const file = draftDocument(report, reviewId, first.path, first.range)
      const thread = this.#controller.createCommentThread(changedFileUri(file.reviewId, file.side, file.path), lineRangeOf(first.range), [])
      this.#markAsDraft(thread, reviewId)
      thread.comments = drafts.map((draft) => new DraftComment(draft, thread))
      return [thread]
    })
  }

  #hostThreads(reviewId: number, report: ReviewModel, threads: readonly ReviewThread[]): vscode.CommentThread[] {
    return threads.flatMap((hostThread) => {
      const place = threadPlace(hostThread, report)
      if (place === undefined) return []
      const line = new vscode.Range(place.line - 1, 0, place.line - 1, 0)
      const thread = this.#controller.createCommentThread(changedFileUri(reviewId, place.side, place.documentPath), line, hostThread.comments.map(hostComment))
      thread.contextValue = hostThread.isResolved ? HOST_RESOLVED : HOST_OPEN
      thread.state = hostThread.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved
      thread.collapsibleState = hostThread.isResolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded
      if (hostThread.isOutdated) thread.label = "Outdated"
      this.#origins.set(thread, { kind: "host", reviewId, threadId: hostThread.id })
      return [thread]
    })
  }

  #markAsDraft(thread: vscode.CommentThread, reviewId: number): void {
    thread.contextValue = DRAFT
    thread.label = PENDING_LABEL
    thread.canReply = true
    this.#origins.set(thread, { kind: "draft", reviewId })
    const shown = this.#shown.get(reviewId)
    if (shown !== undefined && !shown.includes(thread)) shown.push(thread)
  }

  #reviewIdOf(thread: vscode.CommentThread): number {
    const origin = this.#origins.get(thread) ?? parseChangedFileUri(thread.uri)
    if (origin === undefined) throw new UserFacingError("That comment isn't on a Walkdiff review.")
    return origin.reviewId
  }
}

function hostComment(comment: { readonly author: string; readonly body: string; readonly createdAt: string }): vscode.Comment {
  return { author: { name: comment.author }, body: new vscode.MarkdownString(comment.body), mode: vscode.CommentMode.Preview, contextValue: HOST_COMMENT, timestamp: new Date(comment.createdAt) }
}

/** The document a draft's lines are in: the base side for a comment on old lines. */
function draftDocument(report: ReviewModel, reviewId: number, path: string, range: LineRange): ChangedFileRef {
  const side = range.side === lineSideOf(FileSide.Base) ? FileSide.Base : FileSide.Head
  const diff = report.files.find((file) => file.diff.path === path)?.diff
  const documentPath = side === FileSide.Base && diff !== undefined ? previousPathOf(diff) : path
  return { reviewId, side, path: documentPath }
}

function lineRangeOf({ side, start, end }: LineRange): vscode.Range {
  return new vscode.Range(lineNumberOf(start, side) - 1, 0, lineNumberOf(end, side) - 1, 0)
}

/** Re-sets a thread's comments, which is how VS Code learns that one of them changed. */
function refresh(thread: vscode.CommentThread): void {
  thread.comments = [...thread.comments]
}

/** The host takes a comment or a request for changes only with something to say. */
function needsBody(event: ReviewEvent, comments: number): boolean {
  return event !== ReviewEvent.Approve && comments === 0
}

function submitTitle(comments: number, unplaced: number): string {
  const counted = comments === 1 ? "1 comment" : `${comments} comments`
  if (unplaced === 0) return `Submit your review with ${counted}`
  return `Submit your review with ${counted}. ${unplaced} no longer fit the diff after new commits, so they go in the review's text.`
}
