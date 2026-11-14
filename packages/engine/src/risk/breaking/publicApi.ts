import { changedUnitsOf, codeSpan, isTestPath, isTestUnit, ModificationWeight, ReferenceConfidence, RiskCategory, RiskSeverity, SyntaxAnalysisStatus, UnitChangeKind, UnitImpactStatus, UnitKind, untouchedReferences } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, Reference, Risk, UnitSnapshot } from "@walkdiff/review-model"
import { escapeRegExp } from "../../impact/candidateFiles.ts"
import { simpleTypeName } from "../../impact/traceImpact.ts"
import type { FileVersions } from "../../syntax/compareUnits.ts"
import type { Definition } from "../../syntax/definitions.ts"
import { languageSpecFor } from "../../syntax/languages.ts"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import type { LibrarySurface } from "./librarySurface.ts"
import { signatureChanges } from "./signatureChanges.ts"

const KIND_WORDS: ReadonlyMap<UnitKind, string> = new Map([
  [UnitKind.Function, "function"],
  [UnitKind.Method, "method"],
  [UnitKind.Class, "class"],
  [UnitKind.Struct, "struct"],
  [UnitKind.Enum, "enum"],
  [UnitKind.Trait, "trait"],
  [UnitKind.Interface, "interface"],
  [UnitKind.TypeAlias, "type"],
  [UnitKind.Constant, "constant"],
])
// Called with arguments by name of the class, unlike hooks such as `__eq__`.
const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["__init__", "__new__", "__call__", "constructor"])
// These leave the call signature as written. Any other decorator can change it, or means a framework calls it.
const TRANSPARENT_DECORATORS: ReadonlySet<string> = new Set(["staticmethod", "classmethod", "abstractmethod", "deprecated", "override", "final", "property", "cached_property", "cache", "lru_cache"])
const DECORATOR = /^\s*@([\w.]+)/
const CERTAIN_CONFIDENCES: ReadonlySet<ReferenceConfidence> = new Set([ReferenceConfidence.Exact, ReferenceConfidence.Likely])
// Past this, a deleted module reads better as one finding listing its contents than as one stop per item.
const MAX_SEPARATE_REMOVALS = 2
const MAX_CALLERS_NAMED = 3
const MAX_POSSIBLE_CALLERS = 5
const MAX_REMOVALS_NAMED = 5

/** A changed unit next to its parsed versions, which hold more than the review model keeps. */
interface ApiUnit {
  readonly unit: ChangedUnit
  readonly path: string
  readonly before: Definition
  readonly after: Definition | undefined
  /** Whether code outside the repository can reach it, so callers we can't see may exist. */
  readonly reachable: boolean
}

export interface PublicApiScan {
  readonly files: readonly ChangedFile[]
  readonly versions: readonly FileVersions[]
  /** Head text by path, where it was read. */
  readonly headTexts: ReadonlyMap<string, string>
  readonly surface: LibrarySurface
}

/**
 * Flags public functions and types changed in ways their callers may notice.
 *
 * What is public comes from the language's own rules: `export`, a bare `pub`, no leading underscore.
 * That alone isn't enough, since an app or a binary crate marks its internal modules the same way.
 * So a change is flagged only with evidence that someone is affected: callers this PR left
 * untouched, or code a library exposes to other projects. A public item whose every caller
 * was updated in an app is an ordinary refactor, and flagging it would be a false alarm.
 */
export function scanPublicApi(scan: PublicApiScan): Risk[] {
  const namesAtHead = new Set(scan.versions.flatMap((version) => (version.after?.definitions ?? []).map((definition) => definition.name)))
  return scan.files.flatMap((file) => {
    const versions = scan.versions.find((version) => version.path === file.diff.path)
    if (versions === undefined || file.noise !== null || isTestPath(file.diff.path)) return []
    const units = apiUnitsOf(file, versions, scan.surface)
    const stillProvided = stillProvidedIn(versions, scan.headTexts.get(file.diff.path), namesAtHead)
    return [...findingsForRemovals(units, stillProvided), ...units.flatMap((unit) => findingsForChange(unit, file, versions, stillProvided))]
  })
}

function apiUnitsOf(file: ChangedFile, versions: FileVersions, surface: LibrarySurface): ApiUnit[] {
  // Compared units keep one of the snapshot objects of their definitions, collapsed or whole, which
  // identifies each side exactly. Names can't: renames change them, and overloads share them.
  const definitions = [...(versions.before?.definitions ?? []), ...(versions.after?.definitions ?? [])]
  const bySnapshot = new Map<UnitSnapshot, Definition>(definitions.flatMap((definition) => [[definition.snapshot, definition], [definition.wholeSnapshot, definition]]))
  const beforePath = "previousPath" in file.diff ? file.diff.previousPath : file.diff.path
  return changedUnitsOf(file).flatMap((unit) => {
    if (!KIND_WORDS.has(unit.kind) || isTestUnit(unit) || !("before" in unit.change)) return []
    const before = bySnapshot.get(unit.change.before)
    const after = "after" in unit.change ? bySnapshot.get(unit.change.after) : undefined
    if (before === undefined || !isPublicApi(before, unit, versions, file.diff.path)) return []
    return [{ unit, path: file.diff.path, before, after, reachable: surface(beforePath, topLevelName(unit.qualifiedName, file.diff.path)) }]
  })
}

function isPublicApi(definition: Definition, unit: ChangedUnit, versions: FileVersions, path: string): boolean {
  const spec = languageSpecFor(path)
  if (spec === undefined || !definition.isPublic) return false
  if (spec.isImplicitlyInvoked(unit.name) && !CONSTRUCTOR_NAMES.has(unit.name)) return false
  if (hasOpaqueDecorator(definition)) return false
  // A Rust `pub fn` on a private struct is out of reach, though nothing in the impl block says so.
  const owner = topLevelName(unit.qualifiedName, path)
  const ownerDefinition = versions.before?.definitions.find((candidate) => candidate.name === owner && candidate.parentKey === undefined && candidate.kind !== UnitKind.Impl)
  return ownerDefinition?.isPublic !== false
}

function hasOpaqueDecorator(definition: Definition): boolean {
  const lines = definition.snapshot.text.split("\n")
  const signatureAt = lines.findIndex((line) => line.includes(definition.name) && !DECORATOR.test(line))
  return lines.slice(0, Math.max(0, signatureAt)).some((line) => {
    const decorator = DECORATOR.exec(line)?.[1]
    return decorator !== undefined && !TRANSPARENT_DECORATORS.has(decorator.split(".").at(-1) ?? decorator)
  })
}

function topLevelName(qualifiedName: string, path: string): string {
  return simpleTypeName(qualifiedName.split(languageSpecFor(path)?.separator ?? ".").at(0) ?? qualifiedName)
}

function certainCallers(unit: ChangedUnit): readonly Reference[] {
  return untouchedReferences(unit).filter((reference) => CERTAIN_CONFIDENCES.has(reference.confidence))
}

function findingsForChange(api: ApiUnit, file: ChangedFile, versions: FileVersions, stillProvided: StillProvided): Risk[] {
  const { change } = api.unit
  switch (change.kind) {
    case UnitChangeKind.Renamed:
      return isGone(api, stillProvided, api.before.name) ? findingForRename(api, change.after) : []
    case UnitChangeKind.Modified:
      if (change.weight !== ModificationWeight.Semantic || api.after === undefined) return []
      return api.after.isPublic ? findingForSignature(api, api.after, file, versions) : findingForLostVisibility(api)
    case UnitChangeKind.Added:
    case UnitChangeKind.Removed:
    case UnitChangeKind.MovedIn:
    case UnitChangeKind.MovedOut:
      return []
  }
}

type StillProvided = (name: string) => boolean

/**
 * Whether a name people import is still there after its definition went:
 * - Still defined in a changed file, it was moved or is inherited from a base class. Edits on the way
 *   usually defeat move detection, so the unit shows as removed here and added there.
 * - Still at module level, it is kept as an alias: `old = new`, `pub use new as old`.
 * - Still quoted in the file, a shim serves it, as Python modules do with a deprecating `__getattr__`.
 */
function stillProvidedIn(versions: FileVersions, headText: string | undefined, namesAtHead: ReadonlySet<string>): StillProvided {
  const moduleScope = versions.after?.moduleScope.snapshot.text ?? ""
  return (name) => {
    const escaped = escapeRegExp(name)
    return namesAtHead.has(name) || new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(moduleScope) || new RegExp(`["'\`]${escaped}["'\`]`).test(headText ?? "")
  }
}

// Callers left behind are `reference.stale`'s to report, in stronger terms than this rule could.
function isGone(api: ApiUnit, stillProvided: StillProvided, name: string): boolean {
  return api.reachable && certainCallers(api.unit).length === 0 && !stillProvided(name)
}

function findingsForRemovals(units: readonly ApiUnit[], stillProvided: StillProvided): Risk[] {
  const removed = uniqueByName(units.filter((api) => api.unit.change.kind === UnitChangeKind.Removed && isGone(api, stillProvided, api.unit.name)))
  const first = removed.at(0)
  if (first === undefined) return []
  if (removed.length > MAX_SEPARATE_REMOVALS) {
    const named = removed.slice(0, MAX_REMOVALS_NAMED).map((api) => api.unit.qualifiedName).join(", ")
    const rest = removed.length - MAX_REMOVALS_NAMED
    const rule = apiRule("breaking.api-removed", RiskSeverity.Medium, `${removed.length} public items were removed from ${codeSpan(first.path)}`, `Code outside this repository that uses them may break: ${named}${rest > 0 ? ` and ${rest} more` : ""}. Keep deprecated aliases for a release, or call this out in the release notes.`)
    return [unitFinding(rule, first, null, signatureLine(first.before))]
  }
  return removed.map((api) => {
    const rule = apiRule("breaking.api-removed", RiskSeverity.Medium, `Public ${kindWord(api)} ${codeSpan(api.unit.qualifiedName)} was removed`, `Code outside this repository that uses it may break. ${usersSummary(api.unit, certainCallers(api.unit))} Keep a deprecated alias for a release, or call this out in the release notes.`)
    return unitFinding(rule, api, null, signatureLine(api.before))
  })
}

// TypeScript often declares a type and a value under one name, which is one thing to a reader.
function uniqueByName(units: readonly ApiUnit[]): ApiUnit[] {
  return [...new Map(units.map((api) => [api.unit.qualifiedName, api])).values()]
}

function findingForRename(api: ApiUnit, after: UnitSnapshot): Risk[] {
  const rule = apiRule("breaking.api-renamed", RiskSeverity.Medium, `Public ${kindWord(api)} ${codeSpan(api.before.name)} was renamed to ${codeSpan(api.unit.name)}`, `Code outside this repository that uses the old name may break. ${usersSummary(api.unit, certainCallers(api.unit))} Keep the old name as a deprecated alias for a release, or call this out in the release notes.`)
  return [unitFinding(rule, api, after.startLine, signatureLine(api.before))]
}

function findingForLostVisibility(api: ApiUnit): Risk[] {
  const callers = certainCallers(api.unit).filter((reference) => reference.path !== api.path)
  if (!api.reachable && callers.length === 0) return []
  const rule = apiRule("breaking.api-hidden", callers.length > 0 ? RiskSeverity.High : RiskSeverity.Medium, `Public ${kindWord(api)} ${codeSpan(api.unit.qualifiedName)} is no longer public`, `Code that uses it from another ${api.reachable ? "project or " : ""}file may break. ${callers.length > 0 ? `${usersSummary(api.unit, callers)} Keep it public, or move those callers first.` : "Nothing else in this repository uses it from another file. Keep it public for a release, or call this out in the release notes."}`)
  return [unitFinding(rule, api, api.after?.snapshot.startLine ?? null, signatureLine(api.before))]
}

function findingForSignature(api: ApiUnit, after: Definition, file: ChangedFile, versions: FileVersions): Risk[] {
  const language = file.syntax.status === SyntaxAnalysisStatus.Analyzed ? file.syntax.language : undefined
  // Overloads pair up by position in the file, so an edit nearby can compare two different overloads.
  if (language === undefined || api.before.shape === undefined || after.shape === undefined || hasOverloads(api, versions)) return []
  const changes = signatureChanges(language, api.before.shape, after.shape)
  const clauses = [...changes.certain, ...changes.possible]
  const first = clauses.at(0)
  const callers = callSites(api.unit)
  if (first === undefined || (!api.reachable && callers.length === 0)) return []
  const breaksNamedCallers = callers.length > 0 && changes.certain.length > 0
  const more = clauses.length > 1 ? ` (and ${clauses.length - 1} more)` : ""
  const rule = apiRule(
    "breaking.api-signature",
    breaksNamedCallers ? RiskSeverity.High : RiskSeverity.Medium,
    `${codeSpan(api.unit.qualifiedName)} ${first}${more}`,
    `${breaksNamedCallers ? "Callers will likely break" : "Callers may break"}: it ${clauses.join(", and ")}. ${usersSummary(api.unit, callers)} ${callers.length > 0 ? "Update them, or keep the old form working with a default value or a wrapper." : "Keep the old form working with a default value or a wrapper, or call this out in the release notes."}`,
  )
  return [unitFinding(rule, api, after.snapshot.startLine, signatureLine(after))]
}

function hasOverloads(api: ApiUnit, versions: FileVersions): boolean {
  const definedTwice = (definitions: readonly Definition[] | undefined): boolean => (definitions ?? []).filter((definition) => definition.qualifiedName === api.unit.qualifiedName).length > 1
  return definedTwice(versions.before?.definitions) || definedTwice(versions.after?.definitions)
}

/**
 * The references that call the function. Only a call can be broken by a signature, and an unrelated
 * `request` variable matches a function named `request`, so this looks for the call on the line.
 */
function callSites(unit: ChangedUnit): readonly Reference[] {
  const call = new RegExp(`(?<![\\w$])${escapeRegExp(unit.name)}\\s*(?:\\(|::<|<[^()]*>\\()`)
  return certainCallers(unit).filter((reference) => call.test(reference.snippet))
}

/** Who is affected, or as much as is known about it, as a sentence. */
function usersSummary(unit: ChangedUnit, certain: readonly Reference[]): string {
  if (certain.length > 0) return `${places(certain.length)} this PR didn't change still ${certain.length === 1 ? "uses" : "use"} it: ${namedCallers(certain)}.`
  const possible = untouchedReferences(unit).filter((reference) => !CERTAIN_CONFIDENCES.has(reference.confidence))
  // Past a few, matches by name are about something else: `x.properties` is rarely a call to `properties`.
  if (possible.length > MAX_POSSIBLE_CALLERS) return "Its name is too common here to tell who uses it."
  if (possible.length > 0) return `${places(possible.length)} this PR didn't change might use it, going by the name: ${namedCallers(possible)}.`
  switch (unit.impact?.status) {
    case UnitImpactStatus.Traced:
      return "Nothing else in this repository still uses it this way."
    case UnitImpactStatus.TooCommon:
      return "Its callers couldn't be traced, because its name is too common."
    case UnitImpactStatus.Skipped:
    case undefined:
      return "Its callers weren't traced."
  }
}

function namedCallers(references: readonly Reference[]): string {
  const named = references.slice(0, MAX_CALLERS_NAMED).map((reference) => `${reference.path}:${reference.line}${reference.callerQualifiedName === null ? "" : ` (${reference.callerQualifiedName})`}`)
  const rest = references.length - MAX_CALLERS_NAMED
  return `${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`
}

function places(count: number): string {
  return count === 1 ? "1 place" : `${count} places`
}

function kindWord(api: ApiUnit): string {
  return KIND_WORDS.get(api.unit.kind) ?? "item"
}

function signatureLine(definition: Definition): string {
  const lines = definition.snapshot.text.split("\n")
  return lines.find((line) => line.includes(definition.name) && !DECORATOR.test(line)) ?? lines.at(0) ?? ""
}

function apiRule(id: string, severity: RiskSeverity, title: string, detail: string): RuleDescription {
  return { id, category: RiskCategory.BreakingChange, severity, title, detail }
}

function unitFinding(rule: RuleDescription, api: ApiUnit, line: number | null, evidence: string): Risk {
  return { ...findingAt(rule, api.path, line, evidence), unit: api.unit.qualifiedName }
}
