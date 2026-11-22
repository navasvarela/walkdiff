import { ReviewStatus } from "@walkdiff/review-model"
import type { PullRequestListing, ReviewSummary } from "@walkdiff/review-model"
import * as vscode from "vscode"
import { AppGoneError, FileSide } from "./appClient.ts"
import type { AppSession } from "./appSession.ts"
import { changedFileUri, parseChangedFileUri } from "./changedFileContent.ts"
import type { DraftComment, ReviewComments } from "./reviewComments.ts"
import { reviewRow } from "./reviewRows.ts"
import { currentHostBranch } from "./gitRepository.ts"
import { OPEN_CHANGE_COMMAND } from "./reviewsView.ts"
import type { ChangeToOpen, ReviewNode, ReviewsView } from "./reviewsView.ts"
import { CancelledError, UserFacingError } from "./userFacingError.ts"

const VIEW_ID = "walkdiff.reviews"
const START_AGAIN_CHOICE = "Start It"
const HTTP_LINK = /^https?:\/\/\S+$/

/** Registers every command in package.json, each reporting its failures to the user. */
export function registerCommands(session: AppSession, view: ReviewsView, comments: ReviewComments): vscode.Disposable[] {
  const commands = new Commands(session, view)
  const handlers: Readonly<Record<string, (...args: never[]) => Promise<void>>> = {
    "walkdiff.reviewCurrentBranch": () => commands.reviewCurrentBranch(),
    "walkdiff.reviewRequested": () => commands.reviewRequested(),
    "walkdiff.reviewByLink": () => commands.reviewByLink(),
    "walkdiff.refreshList": async () => view.refresh(),
    "walkdiff.startApp": () => commands.startApp(),
    "walkdiff.openReport": (node: ReviewNode) => commands.openReport(node.review),
    "walkdiff.analyzeAgain": (node: ReviewNode) => commands.analyzeAgain(node.review),
    "walkdiff.removeReview": (node: ReviewNode) => commands.remove(node.review),
    [OPEN_CHANGE_COMMAND]: (change: ChangeToOpen) => openChange(change),
    "walkdiff.addDraft": (reply: vscode.CommentReply) => comments.addDraft(reply),
    "walkdiff.replyToThread": (reply: vscode.CommentReply) => comments.replyToThread(reply),
    "walkdiff.editDraft": async (comment: DraftComment) => comments.editDraft(comment),
    "walkdiff.saveDraft": (comment: DraftComment) => comments.saveDraft(comment),
    "walkdiff.cancelDraftEdit": async (comment: DraftComment) => comments.cancelDraftEdit(comment),
    "walkdiff.deleteDraft": (comment: DraftComment) => comments.deleteDraft(comment),
    "walkdiff.resolveThread": (thread: vscode.CommentThread) => comments.setResolved(thread, true),
    "walkdiff.reopenThread": (thread: vscode.CommentThread) => comments.setResolved(thread, false),
    "walkdiff.submitReview": async (target?: ReviewNode | vscode.Uri) => comments.submit(await commands.reviewIdFor(target)),
    "walkdiff.refreshComments": async (target?: ReviewNode | vscode.Uri) => comments.reload(await commands.reviewIdFor(target)),
  }
  return Object.entries(handlers).map(([id, handler]) => vscode.commands.registerCommand(id, (...args: never[]) => reportingFailures(session, view, () => handler(...args))))
}

class Commands {
  readonly #session: AppSession
  readonly #view: ReviewsView

  constructor(session: AppSession, view: ReviewsView) {
    this.#session = session
    this.#view = view
  }

  async reviewCurrentBranch(): Promise<void> {
    const { remoteUrl, branch } = await currentHostBranch()
    const client = await this.#session.client()
    const open = await client.openPullRequests(remoteUrl, branch)
    if (open.length === 0) {
      void vscode.window.showInformationMessage(`There's no open pull request from ${branch}. Push it and open one, or review another.`)
      return
    }
    const picked = open.length === 1 ? open[0] : await pickPullRequest(open, `Pull requests from ${branch}`)
    if (picked !== undefined) await this.#add(picked.url)
  }

  async reviewRequested(): Promise<void> {
    const { remoteUrl } = await currentHostBranch()
    const client = await this.#session.client()
    const waiting = await client.reviewRequests(remoteUrl)
    if (waiting.length === 0) {
      void vscode.window.showInformationMessage("No open pull requests are waiting for your review.")
      return
    }
    const picked = await pickPullRequest(waiting, "Pull requests waiting for your review")
    if (picked !== undefined) await this.#add(picked.url)
  }

  async reviewByLink(): Promise<void> {
    const url = await vscode.window.showInputBox({
      prompt: "A GitHub pull request or GitLab merge request",
      placeHolder: "https://github.com/owner/repo/pull/12",
      validateInput: (value) => (HTTP_LINK.test(value.trim()) ? undefined : "Paste the pull request's link"),
    })
    if (url !== undefined) await this.#add(url.trim())
  }

  async startApp(): Promise<void> {
    await this.#session.start()
    this.#view.refresh()
  }

  async openReport(review: ReviewSummary): Promise<void> {
    const client = await this.#session.client()
    await vscode.env.openExternal(vscode.Uri.parse(client.reportPageUrl(review.id)))
  }

  async analyzeAgain(review: ReviewSummary): Promise<void> {
    await (await this.#session.client()).analyzeAgain(review.id)
    this.#view.refresh()
  }

  async remove(review: ReviewSummary): Promise<void> {
    await (await this.#session.client()).remove(review.id)
    this.#view.refresh()
  }

  /**
   * The review a command is about: the one clicked in the view, the one whose file is open, or the
   * one the user picks from the finished reviews.
   */
  async reviewIdFor(target: ReviewNode | vscode.Uri | undefined): Promise<number> {
    if (target !== undefined && !(target instanceof vscode.Uri)) return target.review.id
    const file = parseChangedFileUri(target ?? vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse("untitled:"))
    if (file !== undefined) return file.reviewId
    const ready = (await (await this.#session.client()).reviews()).filter((review) => review.status === ReviewStatus.Ready)
    if (ready.length === 0) throw new UserFacingError("There's no finished review yet.")
    const picked = await vscode.window.showQuickPick(
      ready.map((review) => ({ label: reviewRow(review).label, review })),
      { title: "Which review?" },
    )
    if (picked === undefined) throw new CancelledError()
    return picked.review.id
  }

  async #add(url: string): Promise<void> {
    const ai = vscode.workspace.getConfiguration("walkdiff").get<boolean>("aiReview", false)
    const review = await (await this.#session.client()).addReview(url, ai)
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
    this.#view.refresh()
    void vscode.window.setStatusBarMessage(`Walkdiff is analyzing ${review.displayName}`, 5_000)
  }
}

async function pickPullRequest(listings: readonly PullRequestListing[], title: string): Promise<PullRequestListing | undefined> {
  const picked = await vscode.window.showQuickPick(
    listings.map((listing) => ({
      label: `${listing.displayName} ${listing.title}`,
      description: listing.draft ? `${listing.author} · draft` : listing.author,
      detail: `Updated ${new Date(listing.updatedAt).toLocaleString()}`,
      listing,
    })),
    { title, matchOnDescription: true },
  )
  return picked?.listing
}

/** Opens the PR's change to one file in the diff editor, at a finding's line when there is one. */
async function openChange({ review, path, basePath, line }: ChangeToOpen): Promise<void> {
  const base = changedFileUri(review.id, FileSide.Base, basePath)
  const head = changedFileUri(review.id, FileSide.Head, path)
  const fileName = path.split("/").at(-1) ?? path
  const at = line === undefined ? undefined : new vscode.Range(line - 1, 0, line - 1, 0)
  await vscode.commands.executeCommand("vscode.diff", base, head, `${fileName} (${review.displayName})`, { preview: true, ...(at === undefined ? {} : { selection: at }) })
}

async function reportingFailures(session: AppSession, view: ReviewsView, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error: unknown) {
    if (error instanceof CancelledError) return
    if (error instanceof AppGoneError) {
      session.forget()
      view.refresh()
      const choice = await vscode.window.showWarningMessage(`${error.message} Start it again?`, START_AGAIN_CHOICE)
      if (choice === START_AGAIN_CHOICE) await reportingFailures(session, view, async () => void (await session.start()))
      return
    }
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}
