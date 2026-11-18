import { basename, extname } from "node:path"
import { isTestPath } from "@walkdiff/review-model"
import type { CommitSha } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import { ISOLATED_CONFIG_ENV, runGit } from "../../git.ts"
import { escapeRegExp } from "../../impact/candidateFiles.ts"
import { isNoiseByPath } from "../../noise.ts"
import type { RetiredName } from "./retiredNames.ts"

/** Where a doc still uses a name the PR retires: its first mention in the file, and how many there are. */
export interface StaleMention {
  readonly retired: RetiredName
  readonly path: string
  readonly line: number
  readonly text: string
  readonly count: number
}

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".asciidoc"])
// History and upgrade guides are meant to name what changed, old names included.
const HISTORY_FILE = /change|history|release|news|migrat|upgrad|deprecat|breaking/i
// Enough for any project's docs; repositories are untrusted input, so the reading has a limit.
const MAX_DOC_FILES = 2_000
const MAX_DOC_BYTES = 1_000_000

/**
 * Finds where the docs at `head` still use each retired name. A line naming both the old name and
 * its replacement is describing the rename, so it doesn't count.
 */
export async function staleMentions(repoDir: string, head: CommitSha, retired: readonly RetiredName[]): Promise<StaleMention[]> {
  if (retired.length === 0) return []
  const docs = (await docFiles(repoDir, head)).slice(0, MAX_DOC_FILES)
  const blobs = await readBlobs(repoDir, docs.map((path) => ({ commit: head, path })))
  const matchers = retired.map((name) => ({ retired: name, uses: wordPattern(name.name), describesRename: name.replacement === undefined ? undefined : wordPattern(name.replacement) }))
  return docs.flatMap((path, index) => {
    const blob = blobs.at(index)
    if (blob === undefined || blob.length > MAX_DOC_BYTES) return []
    const lines = blob.toString("utf8").split("\n")
    return matchers.flatMap(({ retired: name, uses, describesRename }) => {
      const hits = lines.flatMap((text, row) => (uses.test(text) && describesRename?.test(text) !== true ? [{ line: row + 1, text: text.trim() }] : []))
      const first = hits.at(0)
      return first === undefined ? [] : [{ retired: name, path, line: first.line, text: first.text, count: hits.length }]
    })
  })
}

async function docFiles(repoDir: string, head: CommitSha): Promise<string[]> {
  const listing = await runGit(["ls-tree", "-r", "-z", "--name-only", head], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })
  return listing.split("\0").filter((path) => DOC_EXTENSIONS.has(extname(path).toLowerCase()) && !HISTORY_FILE.test(basename(path)) && !isNoiseByPath(path) && !isTestPath(path))
}

// The name as a whole word: `--out` isn't `--output`, and `parseConfig` isn't `parseConfigFile`.
function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_$-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$-])`, "u")
}
