import { isTestPath } from "@walkdiff/review-model"
import type { CommitSha } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import { escapeRegExp, filesMentioning } from "../../impact/candidateFiles.ts"

export interface CodeMention {
  readonly path: string
  readonly line: number
  readonly text: string
}

// A plain word in more files than this means nothing: `status` is everywhere. An unusual name that
// widespread is simply widely used, so it gets more room, within what's quick to read.
const MAX_FILES_FOR_A_COMMON_WORD = 25
const MAX_FILES_FOR_A_SPECIFIC_NAME = 200
const COMMENT_LINE = /^\s*(?:\/\/|#|--|\/\*|\*)/
// Code here doesn't run in the deployment or read its settings, so its mentions prove nothing.
const NOT_APPLICATION_CODE = /(^|\/)(?:migrations?|alembic|examples?|demos?|docs?)\/|(^|\/)db\/(?:post_)?migrate\//

/**
 * Where application code at `head` names each of `names`, by the line. Names too common to mean
 * anything are left out of the result, so a missing entry means "can't tell", not "unused".
 * This matches words, not meaning: it says code may be affected, never that it is.
 */
export async function mentionsInCode(repoDir: string, head: CommitSha, names: readonly string[]): Promise<Map<string, CodeMention[]>> {
  const filesByName = await filesMentioning(repoDir, head, names)
  const specific = [...filesByName].map(([name, paths]) => [name, paths.filter((path) => !isTestPath(path) && !NOT_APPLICATION_CODE.test(path))] as const).filter(([name, paths]) => paths.length <= (isSpecificName(name) ? MAX_FILES_FOR_A_SPECIFIC_NAME : MAX_FILES_FOR_A_COMMON_WORD))
  const paths = [...new Set(specific.flatMap(([, files]) => files))]
  const blobs = await readBlobs(repoDir, paths.map((path) => ({ commit: head, path })))
  const linesByPath = new Map(paths.map((path, index) => [path, blobs.at(index)?.toString("utf8").split("\n") ?? []]))
  return new Map(specific.map(([name, files]) => [name, files.flatMap((path) => mentionsIn(path, linesByPath.get(path) ?? [], name))]))
}

function mentionsIn(path: string, lines: readonly string[], name: string): CodeMention[] {
  const word = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$])`, "u")
  return lines.flatMap((text, index) => (word.test(text) && !COMMENT_LINE.test(text) ? [{ path, line: index + 1, text: text.trim() }] : []))
}

const SPECIFIC_NAME_LENGTH = 10
const COMPOUND_NAME = /[_-]|[a-z][A-Z]/

/** Whether a name is unusual enough that seeing it in code probably means this very thing. */
export function isSpecificName(name: string): boolean {
  return name.length >= SPECIFIC_NAME_LENGTH || COMPOUND_NAME.test(name)
}

const MAX_MENTIONS_NAMED = 3

export function describeMentions(mentions: readonly CodeMention[]): string {
  const named = mentions.slice(0, MAX_MENTIONS_NAMED).map((mention) => `${mention.path}:${mention.line}`)
  const rest = mentions.length - MAX_MENTIONS_NAMED
  return `${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`
}
