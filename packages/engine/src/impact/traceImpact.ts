import { ModificationWeight, ReferenceConfidence, UnitChangeKind, UnitImpactStatus, UnitKind } from "@walkdiff/review-model"
import type { CommitSha, ComparedUnit, Reference, UnitImpact } from "@walkdiff/review-model"
import { readBlobs } from "../blobs.ts"
import { extractUnits } from "../syntax/definitions.ts"
import type { Definition } from "../syntax/definitions.ts"
import { IdentifierUseKind } from "../syntax/languageSpec.ts"
import type { IdentifierUse, LanguageSpec } from "../syntax/languageSpec.ts"
import { canReferenceAcross, languageSpecFor } from "../syntax/languages.ts"
import { withSyntaxTree } from "../syntax/parser.ts"
import { filesMentioning } from "./candidateFiles.ts"
import { findIdentifierUses } from "./identifierUses.ts"

/**
 * Beyond this many files, a name is too generic (`new`, `get`, `run`) for a by-name search
 * to say anything useful, and parsing every match would dominate the run time.
 */
const MAX_FILES_PER_NAME = 200
/**
 * Files parsed per run to resolve references. Parsing takes ~5 ms per file (measured on
 * rust-lang/rust), so this keeps impact tracing to roughly ten seconds on huge PRs.
 */
const MAX_PARSED_FILES = 2000
// Enough to judge the impact; the total is still reported.
const MAX_REFERENCES_PER_UNIT = 50
const MAX_SNIPPET_CHARS = 200

const TRACED_KINDS: ReadonlySet<UnitKind> = new Set([
  UnitKind.Function,
  UnitKind.Method,
  UnitKind.Class,
  UnitKind.Struct,
  UnitKind.Enum,
  UnitKind.Trait,
  UnitKind.Interface,
  UnitKind.TypeAlias,
  UnitKind.Constant,
  UnitKind.Macro,
])

const CONFIDENCE_ORDER: Readonly<Record<ReferenceConfidence, number>> = {
  [ReferenceConfidence.Exact]: 0,
  [ReferenceConfidence.Likely]: 1,
  [ReferenceConfidence.Possible]: 2,
}

export interface AnalyzedFile {
  readonly path: string
  readonly spec: LanguageSpec
  readonly units: readonly ComparedUnit[]
  /** Added in this PR: everything in it is new, so every reference from it is "touched". */
  readonly isNew: boolean
}

interface Target {
  readonly unit: ComparedUnit
  readonly path: string
  readonly spec: LanguageSpec
  readonly searchedName: string
  /** For methods, the type or class they belong to; references must agree with it. */
  readonly container: string | undefined
  /** The container's template arguments, `<int>` for C++'s `formatter<int>::format`, without spaces. */
  readonly containerArguments: string | undefined
  /** Lines the unit occupies at head, so its own recursive calls are not reported. */
  readonly ownLines: { readonly first: number; readonly last: number } | undefined
}

/**
 * Finds where the head commit refers to units this PR changed, removed or renamed. Outline:
 * 1. Pick traceable units and the name to search for (the old name for renames).
 * 2. `git grep` for all names to find candidate files; names in too many files are given up.
 * 3. Parse each candidate once, classify identifier uses, and keep those whose syntax
 *    fits the target (e.g. `Other::new` is not a use of `Size::new`).
 * 4. Attribute each reference to its enclosing unit and flag callers this PR left untouched.
 */
export async function traceImpact(
  repoDir: string,
  head: CommitSha,
  files: readonly AnalyzedFile[],
): Promise<Map<ComparedUnit, UnitImpact>> {
  const targets = files.flatMap(targetsIn)
  const impacts = new Map<ComparedUnit, UnitImpact>()
  if (targets.length === 0) {
    return impacts
  }

  const filesByName = await filesMentioning(repoDir, head, [...new Set(targets.map((target) => target.searchedName))])
  const specific = targets.filter((target) => {
    const matches = filesByName.get(target.searchedName) ?? []
    if (matches.length > MAX_FILES_PER_NAME) {
      impacts.set(target.unit, { status: UnitImpactStatus.TooCommon, searchedName: target.searchedName, matchingFiles: matches.length })
      return false
    }
    return true
  })
  const { traceable, candidates } = withinParseBudget(specific, filesByName, (target) => {
    impacts.set(target.unit, {
      status: UnitImpactStatus.Skipped,
      searchedName: target.searchedName,
      reason: `this PR changes too many units to trace them all; callers were traced for the most specific names first`,
    })
  })

  const referencesByTarget = new Map<Target, Reference[]>(traceable.map((target) => [target, []]))
  const touched = touchedCallers(files)
  const contents = await readBlobs(repoDir, candidates.map((path) => ({ commit: head, path })))

  // Targets whose name another unit in the repository also has: a bare use may mean either.
  const ambiguous = new Set<Target>()
  // Sequential on purpose: each parse holds a tree in WASM memory until it is freed.
  for (const [index, path] of candidates.entries()) {
    const source = contents.at(index)?.toString("utf8")
    const spec = languageSpecFor(path)
    if (source === undefined || spec === undefined) continue
    const relevant = traceable.filter(
      (target) => canReferenceAcross(target.spec.language, spec.language) && (filesByName.get(target.searchedName) ?? []).includes(path),
    )
    if (relevant.length === 0) continue
    const { found, redefined } = await referencesInFile(spec, path, source, relevant, touched)
    for (const { target, reference } of found) {
      referencesByTarget.get(target)?.push(reference)
    }
    redefined.forEach((target) => ambiguous.add(target))
  }

  for (const [target, found] of referencesByTarget) {
    const references = ambiguous.has(target) ? found.map(asPossible) : found
    impacts.set(target.unit, {
      status: UnitImpactStatus.Traced,
      searchedName: target.searchedName,
      references: references.sort(byReviewPriority).slice(0, MAX_REFERENCES_PER_UNIT),
      totalReferences: references.length,
    })
  }
  return impacts
}

interface ParsePlan {
  readonly traceable: Target[]
  readonly candidates: string[]
}

/** Admits targets, most specific name first, until their candidate files exceed the budget. */
function withinParseBudget(
  targets: readonly Target[],
  filesByName: ReadonlyMap<string, readonly string[]>,
  skip: (target: Target) => void,
): ParsePlan {
  const filesOf = (target: Target): readonly string[] => filesByName.get(target.searchedName) ?? []
  const candidates = new Set<string>()
  const traceable: Target[] = []
  for (const target of [...targets].sort((a, b) => filesOf(a).length - filesOf(b).length)) {
    const added = filesOf(target).filter((path) => !candidates.has(path))
    if (candidates.size + added.length > MAX_PARSED_FILES) {
      skip(target)
      continue
    }
    added.forEach((path) => candidates.add(path))
    traceable.push(target)
  }
  return { traceable, candidates: [...candidates] }
}

function targetsIn(file: AnalyzedFile): Target[] {
  return file.units.flatMap((unit) => {
    const searchedName = searchedNameFor(unit)
    if (searchedName === undefined) return []
    if (unit.kind === UnitKind.Method && file.spec.isImplicitlyInvoked(searchedName)) return []
    const after = "after" in unit.change ? unit.change.after : undefined
    return [
      {
        unit,
        path: file.path,
        spec: file.spec,
        searchedName,
        container: unit.kind === UnitKind.Method ? containerTypeName(unit.qualifiedName, file.spec.separator) : undefined,
        containerArguments: unit.kind === UnitKind.Method ? templateArguments(containerPath(unit.qualifiedName, file.spec.separator) ?? "") : undefined,
        ownLines: after === undefined ? undefined : { first: after.startLine, last: after.endLine },
      },
    ]
  })
}

/** Only changes that can break or alter callers are traced. */
function searchedNameFor(unit: ComparedUnit): string | undefined {
  if (!TRACED_KINDS.has(unit.kind)) return undefined
  switch (unit.change.kind) {
    case UnitChangeKind.Modified:
      return unit.change.weight === ModificationWeight.Semantic ? unit.name : undefined
    case UnitChangeKind.Removed:
      return unit.name
    case UnitChangeKind.Renamed:
      return unit.change.previousName
    // Callers of an edited move find the new code under the same name.
    case UnitChangeKind.MovedIn:
      return unit.change.edited ? unit.name : undefined
    case UnitChangeKind.Added:
    case UnitChangeKind.MovedOut:
      return undefined
  }
}

interface FoundReference {
  readonly target: Target
  readonly reference: Reference
}

interface FileReferences {
  readonly found: FoundReference[]
  /** Targets whose name this file defines again, as its own unit. */
  readonly redefined: Set<Target>
}

function referencesInFile(
  spec: LanguageSpec,
  path: string,
  source: string,
  targets: readonly Target[],
  touched: ReadonlySet<string>,
): Promise<FileReferences> {
  const names = new Set(targets.map((target) => target.searchedName))
  const lines = source.split("\n")
  return withSyntaxTree(spec, source, (tree) => {
    const definitions = extractUnits(spec, tree, source).definitions
    // A file defining its own unit of the same name refers to that one, not the target.
    const redefined = new Set(targets.filter((target) => definesOwnUnitNamed(definitions, target, path)))
    const found: FoundReference[] = []
    for (const occurrence of findIdentifierUses(spec, tree, names)) {
      const caller = enclosingDefinition(definitions, occurrence.line)
      for (const target of targets) {
        if (target.searchedName !== occurrence.name || redefined.has(target) || isInsideTarget(target, path, occurrence.line)) continue
        const confidence = referenceConfidence(occurrence.use, target, caller, spec)
        if (confidence === undefined) continue
        const callerQualifiedName = caller?.qualifiedName ?? null
        found.push({
          target,
          reference: {
            path,
            line: occurrence.line,
            callerQualifiedName,
            confidence,
            touchedByPullRequest: touched.has(callerKey(path, callerQualifiedName)) || touched.has(newFileKey(path)),
            snippet: (lines.at(occurrence.line - 1) ?? "").trim().slice(0, MAX_SNIPPET_CHARS),
          },
        })
      }
    }
    return { found, redefined }
  })
}

/**
 * Whether the file defines a top-level-style unit with the target's name, other than the
 * target itself. Methods are told apart by their container, so only free items count.
 */
function definesOwnUnitNamed(definitions: readonly Definition[], target: Target, path: string): boolean {
  if (target.container !== undefined) return false
  return definitions.some(
    (definition) =>
      definition.name === target.searchedName &&
      definition.kind !== UnitKind.Method &&
      !(path === target.path && definition.snapshot.startLine === target.ownLines?.first),
  )
}

/**
 * Judges whether a use's syntax fits the target. A mismatched qualifier rules a use out
 * (`Other::new` for `Size::new`); an unknown receiver (`x.parse()`) leaves it possible.
 */
function referenceConfidence(
  use: IdentifierUse,
  target: Target,
  caller: Definition | undefined,
  spec: LanguageSpec,
): ReferenceConfidence | undefined {
  const { container } = target
  switch (use.kind) {
    case IdentifierUseKind.Path:
    case IdentifierUseKind.Member: {
      const qualifier = use.kind === IdentifierUseKind.Path ? use.qualifier : use.receiver
      if (container === undefined) {
        // `walk::scan` for a `scan` defined in walk.rs; `sym::scan` is some other `scan`.
        return use.kind === IdentifierUseKind.Path && qualifiesModuleOf(use.qualifier, target.path)
          ? ReferenceConfidence.Likely
          : ReferenceConfidence.Possible
      }
      if (simpleTypeName(qualifier) === container) {
        return isOtherSpecialization(qualifier, target) ? ReferenceConfidence.Possible : ReferenceConfidence.Exact
      }
      if (spec.selfReceivers.has(qualifier)) {
        return isCalledFromItsContainer(caller, target, spec) ? ReferenceConfidence.Exact : undefined
      }
      // A path names its type explicitly, so a different one is a different item.
      return use.kind === IdentifierUseKind.Path ? undefined : ReferenceConfidence.Possible
    }
    case IdentifierUseKind.Bare:
      if (container === undefined) return ReferenceConfidence.Likely
      // In C++ and Java a method calls its class's other methods by bare name; elsewhere a bare
      // name is never a method. A free function of the same name would read the same.
      return spec.callsMembersByBareName && isCalledFromItsContainer(caller, target, spec) ? ReferenceConfidence.Likely : undefined
  }
}

function isCalledFromItsContainer(caller: Definition | undefined, target: Target, spec: LanguageSpec): boolean {
  const callerContainer = caller === undefined ? undefined : containerPath(caller.qualifiedName, spec.separator)
  return callerContainer !== undefined && simpleTypeName(callerContainer) === target.container && !isOtherSpecialization(callerContainer, target)
}

// `formatter<std::tm>::format` belongs to another specialization than `formatter<int>::format`.
// Template parameters, as in `formatter<T>`, read like types, so a mismatch only makes it less certain.
function isOtherSpecialization(path: string, target: Target): boolean {
  const pathArguments = templateArguments(path)
  return pathArguments !== undefined && target.containerArguments !== undefined && pathArguments !== target.containerArguments
}

function templateArguments(path: string): string | undefined {
  return TRAILING_TEMPLATE_ARGUMENTS.exec(path)?.[0].replace(/\s+/g, "")
}

const TRAILING_TEMPLATE_ARGUMENTS = /<.*>$/

// Path roots that stay within the current crate or module rather than naming one.
const RELATIVE_PATH_ROOTS: ReadonlySet<string> = new Set(["crate", "self", "super"])
// File names that stand for their directory as a module.
const DIRECTORY_MODULE_FILES: ReadonlySet<string> = new Set(["mod", "lib", "main", "__init__", "index"])

function qualifiesModuleOf(qualifier: string, definingPath: string): boolean {
  const last = simpleTypeName(qualifier)
  return RELATIVE_PATH_ROOTS.has(last) || last === moduleNameOf(definingPath)
}

function moduleNameOf(path: string): string {
  const segments = path.split("/")
  const stem = (segments.at(-1) ?? "").replace(/\.[^.]+$/, "")
  return DIRECTORY_MODULE_FILES.has(stem) ? (segments.at(-2) ?? stem) : stem
}

function asPossible(reference: Reference): Reference {
  return reference.confidence === ReferenceConfidence.Exact ? reference : { ...reference, confidence: ReferenceConfidence.Possible }
}

function isInsideTarget(target: Target, path: string, line: number): boolean {
  return target.path === path && target.ownLines !== undefined && line >= target.ownLines.first && line <= target.ownLines.last
}

// Definitions come parents first, so the last one containing the line is the innermost.
function enclosingDefinition(definitions: readonly Definition[], line: number): Definition | undefined {
  return definitions.findLast((definition) => definition.snapshot.startLine <= line && line <= definition.snapshot.endLine)
}

function touchedCallers(files: readonly AnalyzedFile[]): Set<string> {
  const keys = new Set<string>()
  for (const file of files) {
    if (file.isNew) keys.add(newFileKey(file.path))
    for (const unit of file.units) {
      // Units that left the file no longer enclose anything at head.
      if (unit.change.kind === UnitChangeKind.Removed || unit.change.kind === UnitChangeKind.MovedOut) continue
      keys.add(callerKey(file.path, unit.kind === UnitKind.ModuleScope ? null : unit.qualifiedName))
    }
  }
  return keys
}

function callerKey(path: string, qualifiedName: string | null): string {
  return `${path}\0${qualifiedName ?? ""}`
}

function newFileKey(path: string): string {
  return `${path}\0\0new`
}

function byReviewPriority(a: Reference, b: Reference): number {
  return (
    Number(a.touchedByPullRequest) - Number(b.touchedByPullRequest) ||
    CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
    a.path.localeCompare(b.path) ||
    a.line - b.line
  )
}

/** `Size::new` → `Size`; `<Size as fmt::Display>::fmt` → `Size`; `Parser.parse` → `Parser`. */
export function containerTypeName(qualifiedName: string, separator: string): string | undefined {
  const path = containerPath(qualifiedName, separator)
  return path === undefined ? undefined : simpleTypeName(path)
}

function containerPath(qualifiedName: string, separator: string): string | undefined {
  const cut = qualifiedName.lastIndexOf(separator)
  return cut === -1 ? undefined : qualifiedName.slice(0, cut)
}

/** Reduces a type path to its bare name: `<Foo as Trait>`, `crate::a::Foo<T>` → `Foo`. */
export function simpleTypeName(path: string): string {
  const traitImpl = /^<(.+?) as .+>$/.exec(path)?.at(1) ?? path
  const withoutGenerics = traitImpl.replace(/<.*>$/, "")
  return withoutGenerics.split(/::|\./).at(-1) ?? withoutGenerics
}
