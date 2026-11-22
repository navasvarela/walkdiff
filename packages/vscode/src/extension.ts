import * as vscode from "vscode"
import { AppSession } from "./appSession.ts"
import { CHANGED_FILE_SCHEME, ChangedFileContent } from "./changedFileContent.ts"
import { registerCommands } from "./commands.ts"
import { DraftStore } from "./drafts.ts"
import { ReportCache } from "./reportCache.ts"
import { ReviewComments } from "./reviewComments.ts"
import { ReviewsView } from "./reviewsView.ts"

export function activate(context: vscode.ExtensionContext): void {
  const session = new AppSession()
  const reports = new ReportCache(async (id) => (await session.client()).report(id))
  const view = new ReviewsView(session, reports, async (review) => vscode.commands.executeCommand("walkdiff.openReport", { kind: "review", review }))
  const comments = new ReviewComments(session, reports, new DraftStore(context.workspaceState))
  const showComments = (document: vscode.TextDocument): void => {
    comments.show(document).catch((error: unknown) => void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)))
  }
  context.subscriptions.push(
    view,
    comments,
    vscode.window.createTreeView("walkdiff.reviews", { treeDataProvider: view, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(CHANGED_FILE_SCHEME, new ChangedFileContent(session)),
    vscode.workspace.onDidOpenTextDocument(showComments),
    ...registerCommands(session, view, comments),
  )
  vscode.workspace.textDocuments.forEach(showComments)
}

export function deactivate(): void {}
