import * as vscode from "vscode"
import { hostBranch } from "./gitRemote.ts"
import type { GitRemote, HostBranch, Upstream } from "./gitRemote.ts"
import { CancelledError, UserFacingError } from "./userFacingError.ts"

// The parts of the built-in git extension's API this extension uses. Its full typings ship with
// VS Code's source as git.d.ts, not with @types/vscode.
interface GitBranch {
  readonly name?: string
  readonly upstream?: Upstream
}

interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly state: { readonly HEAD: GitBranch | undefined; readonly remotes: readonly GitRemote[] }
}

interface GitApi {
  readonly repositories: readonly GitRepository[]
  getRepository(uri: vscode.Uri): GitRepository | null
}

interface GitExtension {
  getAPI(version: 1): GitApi
}

const GIT_EXTENSION_ID = "vscode.git"
const GIT_API_VERSION = 1

/** The repository a command is about: the one of the file being edited, or the one the user picks. */
async function currentRepository(): Promise<GitRepository> {
  const extension = vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION_ID)
  if (extension === undefined) throw new UserFacingError("Walkdiff needs VS Code's built-in Git extension, which is turned off.")
  const git = (await extension.activate()).getAPI(GIT_API_VERSION)
  const activeUri = vscode.window.activeTextEditor?.document.uri
  const active = activeUri === undefined ? null : git.getRepository(activeUri)
  if (active !== null) return active
  const [only, ...others] = git.repositories
  if (only === undefined) throw new UserFacingError("Open a folder with a git repository from GitHub or GitLab first.")
  if (others.length === 0) return only
  const picked = await vscode.window.showQuickPick(
    git.repositories.map((repository) => ({ label: vscode.workspace.asRelativePath(repository.rootUri, false) || repository.rootUri.fsPath, repository })),
    { placeHolder: "Which repository?" },
  )
  if (picked === undefined) throw new CancelledError()
  return picked.repository
}

/** The current repository's branch, as its host knows it. */
export async function currentHostBranch(): Promise<HostBranch> {
  const repository = await currentRepository()
  const head = repository.state.HEAD
  if (head?.name === undefined) throw new UserFacingError("Check out a branch first: this repository is on a detached HEAD.")
  const branch = hostBranch(head.name, head.upstream, repository.state.remotes)
  if (branch === undefined) throw new UserFacingError("This repository has no remote, so Walkdiff can't tell where its pull requests are.")
  return branch
}
