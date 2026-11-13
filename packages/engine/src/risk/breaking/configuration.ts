import { codeSpan, DiffLineKind, FileChangeStatus, FileContentKind, isTestPath, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { DiffLine, FileDiff, Hunk, Risk } from "@walkdiff/review-model"
import { escapeRegExp } from "../../impact/candidateFiles.ts"
import { languageSpecFor } from "../../syntax/languages.ts"
import { findingAt, isThirdParty } from "../scannedFile.ts"
import type { RuleDescription, ScannedFile } from "../scannedFile.ts"
import { describeMentions, isSpecificName } from "./codeMentions.ts"
import type { CodeMention } from "./codeMentions.ts"

const ENV_FILE = /(^|\/)(?:\.env(?:\.[\w-]+)*|[\w-]*\.env|env\.(?:example|sample|template|dist))$/
const CI_FILE = /^\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|^\.circleci\/|(^|\/)azure-pipelines\.ya?ml$|(^|\/)docker-compose[^/]*\.ya?ml$|(^|\/)compose\.ya?ml$/
const CONFIG_FILE = /(^|\/)(?:config|conf|settings)\/[^/]+\.(?:ya?ml|json|toml|ini)$|(^|\/)(?:settings|config|appsettings|application)(?:\.[\w-]+)*\.(?:ya?ml|json|toml|ini)$|\.(?:example|sample)\.(?:ya?ml|json|toml|ini)$/

const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
// CI and compose files set variables as `FOO: x` or `- FOO=x`; capitals tell them from ordinary keys like `name:`.
const CI_VARIABLE = /^\s*-?\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*(.*)$/
const CONFIG_KEY = /^\s*-?\s*"?([A-Za-z_][\w.-]*)"?\s*[:=]\s*(.*)$/

const ENV_READ = /(?:process\.env|import\.meta\.env)(?:\.|\[\s*["'`])([A-Z][A-Z0-9_]+)|(?:os\.environ(?:\.get)?|os\.getenv|getenv|env::var(?:_os)?|env!|option_env!)\s*[[(]\s*["']([A-Z][A-Z0-9_]+)["']/
const READS_ENVIRONMENT = /\benv\b|environ|getenv/
// A read with a fallback keeps working when the variable is gone.
const READ_HAS_DEFAULT = /(?:getenv|\.get)\([^,)]+,|\?\?|\|\||unwrap_or|\bor\b/

export const ConfigChangeKind = {
  /** Removed from a config file while code may still read it. */
  RemovedVariable: "removedVariable",
  /** Replaced by another name in an env file; deployments set the old one. */
  RenamedVariable: "renamedVariable",
  /** Code stopped reading one variable and started reading another in the same place. */
  ReplacedRead: "replacedRead",
  RemovedKey: "removedKey",
} as const
export type ConfigChangeKind = (typeof ConfigChangeKind)[keyof typeof ConfigChangeKind]

export interface ConfigChange {
  readonly kind: ConfigChangeKind
  readonly name: string
  readonly newName: string | undefined
  readonly path: string
  /** Null where the name only exists on a removed line. */
  readonly line: number | null
  readonly evidence: string
}

interface Replacement {
  readonly removed: readonly DiffLine[]
  readonly added: readonly DiffLine[]
}

/** Runs of removed lines and the added lines right after them: how an edit in place looks in a diff. */
function replacementsIn(hunk: Hunk): Replacement[] {
  const blocks: { removed: DiffLine[]; added: DiffLine[] }[] = []
  let open: { removed: DiffLine[]; added: DiffLine[] } | undefined
  for (const line of hunk.lines) {
    if (line.kind === DiffLineKind.Context) {
      open = undefined
      continue
    }
    if (open === undefined || (line.kind === DiffLineKind.Removed && open.added.length > 0)) {
      open = { removed: [], added: [] }
      blocks.push(open)
    }
    if (line.kind === DiffLineKind.Removed) open.removed.push(line)
    else open.added.push(line)
  }
  return blocks
}

function hunksOf(diff: FileDiff): readonly Hunk[] {
  return diff.content.kind === FileContentKind.Binary ? [] : diff.content.hunks
}

interface KeyLine {
  readonly key: string
  readonly value: string
  readonly line: DiffLine
}

function keyOf(pattern: RegExp, line: DiffLine): KeyLine | undefined {
  const match = pattern.exec(line.content)
  const key = match?.[1]
  return key === undefined ? undefined : { key, value: (match?.[2] ?? "").trim(), line }
}

function isStillInFile(file: ScannedFile, key: string): boolean {
  return new RegExp(`(?<![\\w-])${escapeRegExp(key)}(?![\\w-])`).test(file.after ?? "")
}

const NAME_WORD = /[_-]|(?<=[a-z])(?=[A-Z])/

// The last word says what kind of setting it is: `DATABASE_URL` and `DB_URL` could be the same thing,
// while `APP_URL` and `APP_KEY` next to each other in a file share a word and nothing else.
function endsInTheSameWord(a: string, b: string): boolean {
  return a.split(NAME_WORD).at(-1)?.toLowerCase() === b.split(NAME_WORD).at(-1)?.toLowerCase()
}

/**
 * A removed key and the added one replacing it, when a value or name shows they're the same setting.
 * Examples often leave values empty, which says nothing, and they don't keep their order, so each
 * removed key looks through the whole block for its partner.
 */
function renamePairs(diff: FileDiff, pattern: RegExp): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const { removed, added } of hunksOf(diff).flatMap(replacementsIn)) {
    const newKeys = added.flatMap((line) => keyOf(pattern, line) ?? [])
    for (const oldKey of removed.flatMap((line) => keyOf(pattern, line) ?? [])) {
      const partner = newKeys.find((key) => key.key !== oldKey.key && key.value !== "" && key.value === oldKey.value) ?? newKeys.find((key) => key.key !== oldKey.key && endsInTheSameWord(key.key, oldKey.key))
      if (partner !== undefined) pairs.set(oldKey.key, partner.key)
    }
  }
  return pairs
}

function removedKeys(file: ScannedFile, pattern: RegExp): KeyLine[] {
  const removed = hunksOf(file.diff).flatMap((hunk) => hunk.lines).flatMap((line) => (line.kind === DiffLineKind.Removed ? (keyOf(pattern, line) ?? []) : []))
  return removed.filter((key) => !isStillInFile(file, key.key))
}

function isCommented(line: string): boolean {
  return /^\s*(?:#|\/\/|;)/.test(line)
}

function fromEnvFile(file: ScannedFile): ConfigChange[] {
  const renames = renamePairs(file.diff, ENV_ASSIGNMENT)
  return removedKeys(file, ENV_ASSIGNMENT).map((key) => {
    const newName = renames.get(key.key)
    return { kind: newName === undefined ? ConfigChangeKind.RemovedVariable : ConfigChangeKind.RenamedVariable, name: key.key, newName, path: file.diff.path, line: null, evidence: key.line.content }
  })
}

// A rename inside a pipeline is self-contained, since the pipeline sets its own variables.
// It only matters if code still reads the old name, which is what a removal already checks.
function fromCiFile(file: ScannedFile): ConfigChange[] {
  return removedKeys(file, CI_VARIABLE).map((key) => ({ kind: ConfigChangeKind.RemovedVariable, name: key.key, newName: undefined, path: file.diff.path, line: null, evidence: key.line.content }))
}

function fromConfigFile(file: ScannedFile): ConfigChange[] {
  const renames = renamePairs(file.diff, CONFIG_KEY)
  return removedKeys(file, CONFIG_KEY)
    .filter((key) => isSpecificName(key.key) && !isCommented(key.line.content))
    .map((key) => ({ kind: ConfigChangeKind.RemovedKey, name: key.key, newName: renames.get(key.key), path: file.diff.path, line: null, evidence: key.line.content }))
}

function envReadIn(content: string): string | undefined {
  const match = ENV_READ.exec(content)
  return match?.[1] ?? match?.[2]
}

function fromCodeFile(file: ScannedFile): ConfigChange[] {
  return hunksOf(file.diff).flatMap(replacementsIn).flatMap(({ removed, added }) => {
    const oldReads = removed.flatMap((line) => envReadIn(line.content) ?? [])
    const newReads = added.flatMap((line) => {
      const name = envReadIn(line.content)
      return name === undefined || READ_HAS_DEFAULT.test(line.content) ? [] : [{ name, line }]
    })
    const oldName = oldReads.at(0)
    const next = newReads.at(0)
    if (oldReads.length !== 1 || newReads.length !== 1 || oldName === undefined || next === undefined || oldName === next.name || next.line.kind !== DiffLineKind.Added) return []
    return [{ kind: ConfigChangeKind.ReplacedRead, name: oldName, newName: next.name, path: file.diff.path, line: next.line.newLine, evidence: next.line.content }]
  })
}

/** Finds settings this PR takes away. Each still has to be checked against the code that reads it. */
export function findConfigChanges(files: readonly ScannedFile[]): ConfigChange[] {
  return files.flatMap((file) => {
    const { path, status } = file.diff
    if (isThirdParty(file) || isTestPath(path)) return []
    if (ENV_FILE.test(path)) return fromEnvFile(file)
    if (CI_FILE.test(path)) return fromCiFile(file)
    if (CONFIG_FILE.test(path)) return status === FileChangeStatus.Deleted ? [] : fromConfigFile(file)
    return languageSpecFor(path) === undefined ? [] : fromCodeFile(file)
  })
}

function isRequiredRead(mention: CodeMention): boolean {
  return READS_ENVIRONMENT.test(mention.text) && !READ_HAS_DEFAULT.test(mention.text)
}

function looksLikeKeyRead(mention: CodeMention, key: string): boolean {
  return new RegExp(`["'\`.]${escapeRegExp(key)}\\b`).test(mention.text)
}

const MONOREPO_PROJECT = /^(?:apps|packages|services|libs)\/[^/]+\//

// In a monorepo a variable belongs to one project: another app reading the same name has its own settings.
// A pipeline at the root can't say which project a variable was for, so reads inside any project don't count.
function isInSameProject(mention: CodeMention, path: string): boolean {
  const project = MONOREPO_PROJECT.exec(path)?.[0]
  return project === undefined ? !MONOREPO_PROJECT.test(mention.path) : mention.path.startsWith(project)
}

function rule(id: string, title: string, detail: string): RuleDescription {
  return { id, category: RiskCategory.BreakingChange, severity: RiskSeverity.Medium, title, detail }
}

/**
 * A setting nothing reads can go without harm, so a removal is only a finding when code still
 * reads the name. A rename in an env file or in the code is a finding either way: every
 * deployment sets the old name today, and nothing in the repository can show that they've changed.
 */
export function configChangeFinding(change: ConfigChange, mentions: readonly CodeMention[] | undefined): Risk | undefined {
  const inProject = (mentions ?? []).filter((mention) => isInSameProject(mention, change.path))
  const reads = inProject.filter((mention) => mention.path !== change.path)
  switch (change.kind) {
    case ConfigChangeKind.RemovedVariable: {
      const required = reads.filter(isRequiredRead)
      if (required.length === 0) return undefined
      return findingAt(rule("breaking.env-removed", `Environment variable ${codeSpan(change.name)} was removed from ${codeSpan(change.path)}`, `Code that reads it may fail where it isn't set: ${describeMentions(required)}. Keep it, or give those reads a default.`), change.path, change.line, change.evidence)
    }
    case ConfigChangeKind.RenamedVariable: {
      const required = reads.filter(isRequiredRead)
      const stale = required.length > 0 ? ` Code still reads the old name: ${describeMentions(required)}.` : ""
      return findingAt(rule("breaking.env-renamed", `Environment variable ${codeSpan(change.name)} was renamed to ${codeSpan(change.newName ?? "")}`, `Deployments that set ${change.name} may break until they set ${change.newName ?? ""} too.${stale} Set the new name everywhere before this ships.`), change.path, change.line, change.evidence)
    }
    case ConfigChangeKind.ReplacedRead:
      // Another read of the old name means both are in use, so nothing was replaced.
      if (mentions === undefined || inProject.some((mention) => READS_ENVIRONMENT.test(mention.text))) return undefined
      return findingAt(rule("breaking.env-renamed", `Environment variable ${codeSpan(change.name)} was renamed to ${codeSpan(change.newName ?? "")}`, `The code now reads ${change.newName ?? ""} instead of ${change.name}, so deployments that only set the old name may break. Set the new name everywhere before this ships.`), change.path, change.line, change.evidence)
    case ConfigChangeKind.RemovedKey: {
      const used = reads.filter((mention) => looksLikeKeyRead(mention, change.name))
      if (used.length === 0) return undefined
      const renamed = change.newName === undefined ? "was removed" : `was renamed to ${change.newName}`
      return findingAt(rule("breaking.config-key-removed", `Config key ${codeSpan(change.name)} ${renamed} in ${codeSpan(change.path)}`, `Code that reads it may get nothing back: ${describeMentions(used)}. Update those reads, or keep the key.`), change.path, change.line, change.evidence)
    }
  }
}
