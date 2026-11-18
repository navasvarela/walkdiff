import { changedUnitsOf, isTestPath, isTestUnit, UnitChangeKind } from "@walkdiff/review-model"
import type { ChangedFile } from "@walkdiff/review-model"
import { languageSpecFor } from "../../languages/registry.ts"
import { isSpecificName } from "../breaking/codeMentions.ts"
import { ConfigChangeKind, findConfigChanges } from "../breaking/configuration.ts"
import { addedLines, isThirdParty, removedLines } from "../scannedFile.ts"
import type { ScannedFile } from "../scannedFile.ts"

/** What kind of name a PR retires, which says who notices when docs still use it. */
export const RetiredNameKind = {
  /** A command-line option: whoever copies it from the docs gets an error. */
  CliFlag: "cliFlag",
  /** An environment variable or config key: a deployment set up from the docs silently misses it. */
  Setting: "setting",
  /** A function, class or other unit: whoever reads the docs looks for code that isn't there. */
  Code: "code",
} as const
export type RetiredNameKind = (typeof RetiredNameKind)[keyof typeof RetiredNameKind]

/** A name the PR stops using, which docs may still use. */
export interface RetiredName {
  readonly name: string
  readonly kind: RetiredNameKind
  /** What replaced it, when the PR renamed it. */
  readonly replacement: string | undefined
}

// `"--log-format"`, `'--out'`, `` `--offline <dir>` ``: an option as a string literal in code, or
// opening a line of usage text, as `  --log-format <f>   text or json`. SQL's `-- comment` has a space.
const FLAG_IN_CODE = /(?:["'`]|^\s*)(--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w-])/g
// Unit kinds whose names people look up from the docs; test code is never documented for users.
const DOCUMENTED_UNIT_CHANGES: ReadonlySet<string> = new Set([UnitChangeKind.Removed, UnitChangeKind.Renamed])

/**
 * Names the PR removes or renames: units, command-line options in code, environment variables and
 * config keys. A name only counts once nothing the PR adds still uses it; whether code elsewhere
 * still uses it is for the caller to rule out.
 */
export function retiredNames(files: readonly ChangedFile[], scanned: readonly ScannedFile[]): RetiredName[] {
  const kept = new Set(scanned.flatMap((file) => addedLines(file.diff).flatMap((line) => [...line.content.matchAll(FLAG_IN_CODE)].map((match) => match[1] ?? ""))))
  const names = [...retiredUnits(files), ...retiredFlags(scanned, kept), ...retiredSettings(scanned)]
  const seen = new Set<string>()
  return names.filter((retired) => {
    if (seen.has(retired.name)) return false
    seen.add(retired.name)
    return true
  })
}

function retiredUnits(files: readonly ChangedFile[]): RetiredName[] {
  return files
    .filter((file) => !isTestPath(file.diff.path))
    .flatMap((file) => changedUnitsOf(file))
    .filter((unit) => DOCUMENTED_UNIT_CHANGES.has(unit.change.kind) && !isTestUnit(unit))
    .flatMap((unit): RetiredName[] => {
      const before = unit.change.kind === UnitChangeKind.Renamed ? unit.change.previousName : unit.name
      // A short, plain name such as `run` turns up in prose for other reasons.
      if (!isSpecificName(before)) return []
      return [{ name: before, kind: RetiredNameKind.Code, replacement: unit.change.kind === UnitChangeKind.Renamed ? unit.name : undefined }]
    })
}

function retiredFlags(scanned: readonly ScannedFile[], kept: ReadonlySet<string>): RetiredName[] {
  return scanned
    .filter((file) => languageSpecFor(file.diff.path) !== undefined && !isThirdParty(file) && !isTestPath(file.diff.path))
    .flatMap((file) => removedLines(file.diff).flatMap((line) => [...line.content.matchAll(FLAG_IN_CODE)].map((match) => match[1] ?? "")))
    .filter((flag) => flag !== "" && !kept.has(flag))
    .map((flag) => ({ name: flag, kind: RetiredNameKind.CliFlag, replacement: undefined }))
}

const RETIRED_SETTINGS: ReadonlySet<string> = new Set([ConfigChangeKind.RemovedVariable, ConfigChangeKind.RenamedVariable, ConfigChangeKind.ReplacedRead, ConfigChangeKind.RemovedKey])

function retiredSettings(scanned: readonly ScannedFile[]): RetiredName[] {
  return findConfigChanges(scanned)
    .filter((change) => RETIRED_SETTINGS.has(change.kind))
    .map((change) => ({ name: change.name, kind: RetiredNameKind.Setting, replacement: change.newName }))
}
