import type { CommitSha } from "@walkdiff/review-model"
import { readBlobs } from "../blobs.ts"
import { ISOLATED_CONFIG_ENV, runGit } from "../git.ts"
import { MAX_SOURCE_FILE_BYTES } from "../limits.ts"
import { isNoiseByPath } from "../noise.ts"
import { languageSpecFor } from "../languages/registry.ts"

// Files read and scanned per round, so memory stays bounded on very large repositories
// (rust-lang/rust has ~140 MB of source at a commit).
export const SCAN_BATCH_FILES = 2000
// Characters that continue an identifier in Rust, TypeScript and Python.
const IDENTIFIER_CHAR = String.raw`[\p{L}\p{N}_$]`

/**
 * Maps each name to the source files at `commit` containing it as a whole word: a cheap
 * text pre-filter, since matches in comments and strings are dropped later when parsed.
 *
 * Why not `git grep`: it costs ~0.3 s per name on large repositories even with `-l`, and
 * gets slower, not faster, with many `-e` patterns in one call (100 s for 500 names on
 * rust-lang/rust). Reading every source file once and scanning it with a single regex
 * took 4 s for the same search.
 */
export async function filesMentioning(
  repoDir: string,
  commit: CommitSha,
  names: readonly string[],
): Promise<Map<string, string[]>> {
  const filesByName = new Map<string, string[]>(names.map((name) => [name, []]))
  if (names.length === 0) {
    return filesByName
  }
  const matcher = wordMatcher(names)
  const paths = await listSourceFiles(repoDir, commit)
  for (let start = 0; start < paths.length; start += SCAN_BATCH_FILES) {
    const batch = paths.slice(start, start + SCAN_BATCH_FILES)
    const blobs = await readBlobs(repoDir, batch.map((path) => ({ commit, path })))
    batch.forEach((path, index) => {
      const blob = blobs.at(index)
      if (blob === undefined || blob.length > MAX_SOURCE_FILE_BYTES) return
      for (const name of new Set(Array.from(blob.toString("utf8").matchAll(matcher), (match) => match[0]))) {
        filesByName.get(name)?.push(path)
      }
    })
  }
  return filesByName
}

/** Source files the engine can parse, leaving out lockfiles and vendored code. */
export async function listSourceFiles(repoDir: string, commit: CommitSha): Promise<string[]> {
  const output = await runGit(["ls-tree", "-r", "-z", "--name-only", commit], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })
  return output.split("\0").filter((path) => path !== "" && languageSpecFor(path) !== undefined && !isNoiseByPath(path))
}

/** Matches any of `names` where it is a whole identifier, not part of a longer one. */
function wordMatcher(names: readonly string[]): RegExp {
  // Longest first, so `parse_all` is not matched as `parse` followed by more characters.
  const alternatives = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp)
  return new RegExp(`(?<!${IDENTIFIER_CHAR})(?:${alternatives.join("|")})(?!${IDENTIFIER_CHAR})`, "gu")
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
