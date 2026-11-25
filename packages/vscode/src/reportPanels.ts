import { readFile } from "node:fs/promises"
import { reportMessageSchema, ReportRequestMethod, savedReportStateSchema } from "@walkdiff/review-model"
import type { ReportMessage, ReportReply } from "@walkdiff/review-model"
import * as vscode from "vscode"
import { AppGoneError } from "./appClient.ts"
import type { AppSession } from "./appSession.ts"
import type { ReportCache, ReviewVersion } from "./reportCache.ts"
import { isAllowedRequest } from "./reportRequests.ts"
import { REPORT_TEMPLATE_FILE, reportPage } from "./reportTemplate.ts"

const VIEW_TYPE = "walkdiff.report"
/** Where each report's progress is kept, by the key the page saves it under. */
const SAVED_STATE_KEY = "walkdiff.reportState"
const SERVICE_UNAVAILABLE = 503
const FORBIDDEN = 403

/** What a panel shows: a review, by its id and version, and its name for the tab. */
export interface ReviewToShow extends ReviewVersion {
  readonly displayName: string
}

/** What else changes when a panel posts to the app, such as the review's threads in the editor. */
export interface PanelEffects {
  readonly afterPosting: (reviewId: number) => void
  readonly onAppGone: () => void
}

/**
 * Each review's report in a VS Code panel: the same page the app serves, with the review path,
 * risks and conversation. The page's calls to the app come here, and only those its review needs
 * go on, with the extension's key.
 */
export class ReportPanels implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext
  readonly #session: AppSession
  readonly #reports: ReportCache
  readonly #effects: PanelEffects
  readonly #panels = new Map<number, vscode.WebviewPanel>()
  #template: Promise<string> | undefined

  constructor(context: vscode.ExtensionContext, session: AppSession, reports: ReportCache, effects: PanelEffects) {
    this.#context = context
    this.#session = session
    this.#reports = reports
    this.#effects = effects
  }

  dispose(): void {
    for (const panel of this.#panels.values()) panel.dispose()
  }

  /** Shows the review's report, in its open panel if there is one, refreshed if the review changed. */
  async open(review: ReviewToShow): Promise<void> {
    const report = await this.#reports.current(review)
    const html = reportPage(await this.#templatePage(), report, review.id, this.#savedState())
    const existing = this.#panels.get(review.id)
    if (existing !== undefined) {
      if (existing.webview.html !== html) existing.webview.html = html
      existing.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, review.displayName, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] })
    panel.iconPath = vscode.Uri.joinPath(this.#context.extensionUri, "media", "icon.png")
    panel.webview.html = html
    panel.webview.onDidReceiveMessage((message: unknown) => void this.#answer(panel, review.id, message))
    panel.onDidDispose(() => this.#panels.delete(review.id))
    this.#panels.set(review.id, panel)
  }

  #templatePage(): Promise<string> {
    this.#template ??= readFile(vscode.Uri.joinPath(this.#context.extensionUri, "dist", REPORT_TEMPLATE_FILE).fsPath, "utf8")
    return this.#template
  }

  #savedState(): Record<string, string> {
    return savedReportStateSchema.safeParse(this.#context.globalState.get(SAVED_STATE_KEY)).data ?? {}
  }

  async #answer(panel: vscode.WebviewPanel, reviewId: number, raw: unknown): Promise<void> {
    const message = reportMessageSchema.safeParse(raw)
    if (!message.success) return
    await this.#handle(panel, reviewId, message.data)
  }

  async #handle(panel: vscode.WebviewPanel, reviewId: number, message: ReportMessage): Promise<void> {
    switch (message.type) {
      case "save":
        await this.#context.globalState.update(SAVED_STATE_KEY, { ...this.#savedState(), [message.key]: message.value })
        return
      case "openReview":
        await vscode.commands.executeCommand("walkdiff.openReview", message.reviewId)
        return
      case "request":
        await panel.webview.postMessage(await this.#forward(reviewId, message.id, message.method, message.path, message.body))
        return
    }
  }

  async #forward(reviewId: number, id: number, method: ReportRequestMethod, path: string, body: unknown): Promise<ReportReply> {
    if (!isAllowedRequest(reviewId, method, path)) return { type: "response", id, status: FORBIDDEN, body: { error: "The editor doesn't pass this request on." } }
    try {
      const answer = await (await this.#session.client()).forward(method, path, body)
      if (method === ReportRequestMethod.Post && answer.status < 300) this.#effects.afterPosting(reviewId)
      return { type: "response", id, ...answer }
    } catch (error: unknown) {
      if (!(error instanceof AppGoneError)) throw error
      this.#effects.onAppGone()
      return { type: "response", id, status: SERVICE_UNAVAILABLE, body: { error: `${error.message} Start it again from the Walkdiff view.` } }
    }
  }
}
