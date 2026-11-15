import type { CommitSha } from "@walkdiff/review-model"
import { ISOLATED_CONFIG_ENV, runGit } from "../../git.ts"
import { languageFor } from "../../languages/registry.ts"
import type { LibrarySurface, LibrarySurfaceReader, RepositoryFiles } from "./librarySurface.ts"

// Code in these folders ships with no one, or is run rather than imported.
const NON_API_FOLDERS: ReadonlySet<string> = new Set(["examples", "example", "docs", "doc", "scripts", "script", "tools", "benches", "benchmarks", "bench", "fixtures", "testdata", "demo", "demos", "migrations"])

/**
 * Works out which changed code other projects can import, at the commit they depend on today.
 * A `pub` or `export` alone is a poor sign: binary crates, private packages and apps use both for
 * their own modules, and every caller of those is in the repository where it can be traced.
 * Anything this can't establish counts as not reachable, so unsure code never raises a false alarm.
 */
export async function readLibrarySurface(repoDir: string, commit: CommitSha, changedPaths: readonly string[]): Promise<LibrarySurface> {
  const listing = await runGit(["ls-tree", "-r", "-z", "--name-only", commit], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })
  const repository: RepositoryFiles = { commit, repoDir, paths: new Set(listing.split("\0").filter((path) => path !== "")) }
  const candidates = changedPaths.filter((path) => !path.split("/").some((segment) => NON_API_FOLDERS.has(segment)))
  // Languages of one ecosystem, such as TypeScript and TSX, share a reader, which reads their files together.
  const pathsByReader = new Map<LibrarySurfaceReader, string[]>()
  for (const path of candidates) {
    const reader = languageFor(path)?.librarySurface
    if (reader === undefined) continue
    const paths = pathsByReader.get(reader)
    if (paths === undefined) pathsByReader.set(reader, [path])
    else paths.push(path)
  }
  const surfaces = await Promise.all([...pathsByReader].map(([reader, paths]) => reader(repository, paths)))
  return (path, name) => surfaces.some((surface) => surface(path, name))
}
