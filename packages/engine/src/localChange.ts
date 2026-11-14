import { basename } from "node:path"
import { commitShaSchema, LOCAL_CHANGE_HOST } from "@walkdiff/review-model"
import type { CommitSha, LocalChange } from "@walkdiff/review-model"
import { GitCommandError, ISOLATED_CONFIG_ENV, runGit } from "./git.ts"

export interface LocalChangeRequest {
  /** Anywhere inside the repository, usually the folder Walkdiff was started in. */
  readonly cwd: string
  /** What the branch will merge into; undefined uses the remote's default branch. */
  readonly baseRef: string | undefined
}

export interface LocalCheckout {
  /** The repository's top folder, which the analysis reads committed code from. */
  readonly repoDir: string
  readonly change: LocalChange
  /** Tracked files with changes not yet committed, which the review leaves out. */
  readonly uncommittedFiles: number
}

export class LocalChangeError extends Error {
  override readonly name = "LocalChangeError"
}

// Tried in order when no base is named: the remote's default branch, then the usual names.
const DEFAULT_BASE_REFS: readonly string[] = ["main", "master"]
const REMOTE_DEFAULT_BRANCH = "refs/remotes/origin/HEAD"
const DETACHED_HEAD = "HEAD"

/**
 * Reads the committed work on the current branch, from where it left its base, without changing
 * the repository: every command here only reads, and `status` takes no locks.
 *
 * # Errors
 *
 * Throws a `LocalChangeError` outside a git repository, when the base can't be found, or when the
 * branch has no commits of its own.
 */
export async function readLocalChange(request: LocalChangeRequest): Promise<LocalCheckout> {
  const repoDir = await topLevel(request.cwd)
  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: ISOLATED_CONFIG_ENV }).then((output) => output.trim())

  const headSha = await commitOf(git, DETACHED_HEAD)
  const branch = await git("rev-parse", "--abbrev-ref", DETACHED_HEAD)
  const headRef = branch === DETACHED_HEAD ? headSha.slice(0, 12) : branch
  const baseRef = request.baseRef ?? (await defaultBase(git))
  const baseSha = await commitOf(git, baseRef)
  const mergeBaseSha = commitShaSchema.parse(await git("merge-base", baseSha, headSha).catch(() => {
    throw new LocalChangeError(`${headRef} and ${baseRef} have no history in common.`)
  }))
  if (mergeBaseSha === headSha) throw new LocalChangeError(`${headRef} has no commits that aren't on ${baseRef} yet. Commit your changes, or name another base with --base.`)

  const subjects = (await git("log", "--format=%s", `${mergeBaseSha}..${headSha}`)).split("\n").filter((line) => line !== "")
  const change: LocalChange = {
    host: LOCAL_CHANGE_HOST,
    repositoryName: basename(repoDir),
    // One commit is titled by its message; several, by the branch they're on.
    title: subjects.length === 1 ? (subjects[0] ?? headRef) : headRef,
    description: subjects.map((subject) => `- ${subject}`).join("\n"),
    author: await git("log", "-1", "--format=%an", headSha),
    baseRef,
    headRef,
    baseSha,
    headSha,
    mergeBaseSha,
  }
  const status = await git("--no-optional-locks", "status", "--porcelain", "--untracked-files=no")
  return { repoDir, change, uncommittedFiles: status === "" ? 0 : status.split("\n").length }
}

async function topLevel(cwd: string): Promise<string> {
  try {
    return (await runGit(["rev-parse", "--show-toplevel"], { cwd, env: ISOLATED_CONFIG_ENV })).trim()
  } catch (error: unknown) {
    if (error instanceof GitCommandError) throw new LocalChangeError(`${cwd} isn't inside a git repository.`)
    throw error
  }
}

async function commitOf(git: (...args: string[]) => Promise<string>, ref: string): Promise<CommitSha> {
  try {
    return commitShaSchema.parse(await git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`))
  } catch (error: unknown) {
    if (error instanceof GitCommandError) throw new LocalChangeError(`${ref} isn't a commit, branch or tag in this repository.`)
    throw error
  }
}

async function defaultBase(git: (...args: string[]) => Promise<string>): Promise<string> {
  const remoteDefault = await git("symbolic-ref", "--quiet", "--short", REMOTE_DEFAULT_BRANCH).catch(() => "")
  if (remoteDefault !== "") return remoteDefault
  for (const candidate of DEFAULT_BASE_REFS) {
    const exists = await git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`).then(() => true, () => false)
    if (exists) return candidate
  }
  throw new LocalChangeError(`Couldn't tell which branch this one will merge into. Name it with --base, such as --base main.`)
}
