import * as vscode from "vscode"
import { AppSession } from "./appSession.ts"
import { CHANGED_FILE_SCHEME, ChangedFileContent } from "./changedFileContent.ts"
import { registerCommands } from "./commands.ts"
import { ReviewsView } from "./reviewsView.ts"

export function activate(context: vscode.ExtensionContext): void {
  const session = new AppSession()
  const view = new ReviewsView(session, async (review) => vscode.commands.executeCommand("walkdiff.openReport", { kind: "review", review }))
  context.subscriptions.push(
    view,
    vscode.window.createTreeView("walkdiff.reviews", { treeDataProvider: view, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(CHANGED_FILE_SCHEME, new ChangedFileContent(session)),
    ...registerCommands(session, view),
  )
}

export function deactivate(): void {}
