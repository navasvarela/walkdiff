import { ModificationWeight, UnitChangeKind, UnitKind } from "@walkdiff/review-model"
import type { ComparedUnit, UnitLocation } from "@walkdiff/review-model"
import { MODULE_SCOPE_NAME } from "./definitions.ts"
import type { Definition, FileUnits, ModuleScope } from "./definitions.ts"
import { factsBetween } from "./shape.ts"
import { tokenSimilarity } from "./similarity.ts"

/**
 * Below this many code tokens, identical bodies are too common to call a move:
 * every `fn new() -> Self { Self::default() }` would match every other.
 */
const MIN_MOVED_UNIT_TOKENS = 20

/**
 * How alike, by `tokenSimilarity`, a unit and a same-named one elsewhere must be to call
 * them one unit moved and edited. Measured on the cases in compareUnits.test.ts: a moved
 * function with one call changed scores about 0.93, while unrelated functions sharing a name
 * scored 0.24 to 0.45, and a rewrite of the same function 0.36. Lower, and different code
 * that shares a name would be shown as one edit; higher, and a moved function with a real
 * fix in it would be shown as removed and added again.
 */
const MIN_EDITED_MOVE_SIMILARITY = 0.6

/**
 * Keywords that make a definition visible to other modules. Moving a function into a module
 * of its own usually means exporting it, so a move whose only change is one of these, before
 * the name, is shown as unedited: the new `export` isn't something to review.
 */
const VISIBILITY_KEYWORDS: ReadonlySet<string> = new Set(["export", "pub"])
// Rust narrows `pub` with a group: `pub(crate)`, `pub(super)`, `pub(in path)`.
const RUST_VISIBILITY_GROUP_OPEN = "("
const RUST_VISIBILITY_GROUP_CLOSE = ")"

export interface FileVersions {
  readonly path: string
  /** Units at the merge base; undefined for an added file. */
  readonly before: FileUnits | undefined
  /** Units at the head; undefined for a deleted file. */
  readonly after: FileUnits | undefined
}

interface Located {
  readonly path: string
  readonly definition: Definition
}

/**
 * Compares unit versions across all files of a change. Outline:
 * 1. Per file, pair definitions by key; a pair whose own tokens differ is "modified".
 * 2. Unpaired definitions become added/removed candidates, topmost only (a new class
 *    is reported once, not once per method).
 * 3. Across candidates, an added/removed pair with the same body under a new name in
 *    the same container is a rename; the same body anywhere else is a move.
 * 4. Of the rest, a pair of the same kind and name whose bodies are alike is a move with
 *    edits. The most alike pairs are taken first, so three similar `parse`s can't steal
 *    each other's match.
 * 5. Remaining candidates are reported as added or removed.
 */
export function compareUnits(files: readonly FileVersions[]): Map<string, ComparedUnit[]> {
  const unitsByPath = new Map<string, ComparedUnit[]>(files.map((file) => [file.path, []]))
  const report: Report = (path, unit) => {
    unitsByPath.get(path)?.push(unit)
  }
  const added: Located[] = []
  const removed: Located[] = []

  for (const file of files) {
    const moduleScopeChange = compareModuleScopes(file.before?.moduleScope, file.after?.moduleScope)
    if (moduleScopeChange !== undefined) {
      report(file.path, moduleScopeChange)
    }
    const pairing = pairDefinitions(file)
    pairing.modified.forEach((unit) => report(file.path, unit))
    added.push(...pairing.added.map((definition) => ({ path: file.path, definition })))
    removed.push(...pairing.removed.map((definition) => ({ path: file.path, definition })))
  }

  for (const [from, to] of takeMatches(removed, added, isRename)) {
    report(to.path, {
      ...describe(to.definition),
      change: { kind: UnitChangeKind.Renamed, previousName: from.definition.name, before: from.definition.wholeSnapshot, after: to.definition.wholeSnapshot },
    })
  }
  for (const [from, to] of takeMatches(removed, added, isMove)) {
    reportMove(report, from, to, MoveEdits.None)
  }
  for (const [from, to] of takeMostAlike(removed, added)) {
    reportMove(report, from, to, differsOnlyInVisibility(from.definition, to.definition) ? MoveEdits.None : MoveEdits.Code)
  }
  for (const { path, definition } of added) {
    report(path, { ...describe(definition), change: { kind: UnitChangeKind.Added, after: definition.wholeSnapshot } })
  }
  for (const { path, definition } of removed) {
    report(path, { ...describe(definition), change: { kind: UnitChangeKind.Removed, before: definition.wholeSnapshot } })
  }

  for (const units of unitsByPath.values()) {
    units.sort(byPositionInFile)
  }
  return unitsByPath
}

const MoveEdits = { None: "none", Code: "code" } as const
type MoveEdits = (typeof MoveEdits)[keyof typeof MoveEdits]

type Report = (path: string, unit: ComparedUnit) => void

function reportMove(report: Report, from: Located, to: Located, edits: MoveEdits): void {
  const edited = edits === MoveEdits.Code
  const before = from.definition
  const after = to.definition
  report(from.path, {
    ...describe(before),
    change: { kind: UnitChangeKind.MovedOut, to: locationOf(to), edited, before: before.wholeSnapshot },
  })
  report(to.path, {
    ...describe(after),
    facts: edited && before.shape !== undefined && after.shape !== undefined ? factsBetween(before.shape, after.shape) : null,
    change: { kind: UnitChangeKind.MovedIn, from: locationOf(from), edited, before: before.wholeSnapshot, after: after.wholeSnapshot },
  })
}

interface Pairing {
  readonly modified: ComparedUnit[]
  readonly added: Definition[]
  readonly removed: Definition[]
}

function pairDefinitions(file: FileVersions): Pairing {
  const before = keyed(file.before?.definitions ?? [])
  const after = keyed(file.after?.definitions ?? [])
  const pairing: Pairing = { modified: [], added: [], removed: [] }

  for (const definition of after.values()) {
    const previous = before.get(definition.key)
    if (previous === undefined) {
      if (isTopmostUnpaired(definition, before)) pairing.added.push(definition)
      continue
    }
    const weight = modificationWeight(previous, definition)
    if (weight !== undefined) {
      pairing.modified.push({
        ...describe(definition),
        facts: weight === ModificationWeight.Semantic && previous.shape !== undefined && definition.shape !== undefined ? factsBetween(previous.shape, definition.shape) : null,
        change: { kind: UnitChangeKind.Modified, weight, before: previous.snapshot, after: definition.snapshot },
      })
    }
  }
  for (const definition of before.values()) {
    if (!after.has(definition.key) && isTopmostUnpaired(definition, after)) {
      pairing.removed.push(definition)
    }
  }
  return pairing
}

// An unpaired definition inside an unpaired parent is covered by reporting the parent.
function isTopmostUnpaired(definition: Definition, otherSide: ReadonlyMap<string, Definition>): boolean {
  return definition.parentKey === undefined || otherSide.has(definition.parentKey)
}

/**
 * Compares what a unit owns, leaving out nested units (they are compared on their own).
 * Whitespace inside a container is not reported: it shifts whenever a member is added.
 */
function modificationWeight(before: Definition, after: Definition): ModificationWeight | undefined {
  if (before.fingerprints.ownFull === after.fingerprints.ownFull) {
    const reformatted = !after.hasChildren && before.snapshot.text !== after.snapshot.text
    return reformatted ? ModificationWeight.FormattingOnly : undefined
  }
  return before.fingerprints.ownCode === after.fingerprints.ownCode ? ModificationWeight.CommentsOnly : ModificationWeight.Semantic
}

function compareModuleScopes(before: ModuleScope | undefined, after: ModuleScope | undefined): ComparedUnit | undefined {
  const unit = { kind: UnitKind.ModuleScope, name: MODULE_SCOPE_NAME, qualifiedName: MODULE_SCOPE_NAME, facts: null }
  if (before === undefined && after === undefined) {
    return undefined
  }
  if (before === undefined) {
    return after !== undefined && after.hasOwnTokens ? { ...unit, change: { kind: UnitChangeKind.Added, after: after.snapshot } } : undefined
  }
  if (after === undefined) {
    return before.hasOwnTokens ? { ...unit, change: { kind: UnitChangeKind.Removed, before: before.snapshot } } : undefined
  }
  if (before.ownFull === after.ownFull) {
    return undefined
  }
  const weight = before.ownCode === after.ownCode ? ModificationWeight.CommentsOnly : ModificationWeight.Semantic
  return { ...unit, change: { kind: UnitChangeKind.Modified, weight, before: before.snapshot, after: after.snapshot } }
}

function isRename(from: Located, to: Located): boolean {
  return (
    from.path === to.path &&
    from.definition.kind === to.definition.kind &&
    from.definition.parentKey === to.definition.parentKey &&
    from.definition.name !== to.definition.name &&
    from.definition.fingerprints.nameAgnosticCode === to.definition.fingerprints.nameAgnosticCode
  )
}

function isMove(from: Located, to: Located): boolean {
  return (
    from.definition.kind === to.definition.kind &&
    from.definition.codeTokens.length >= MIN_MOVED_UNIT_TOKENS &&
    from.definition.fingerprints.code === to.definition.fingerprints.code
  )
}

function isEditedMoveCandidate(from: Located, to: Located): boolean {
  return (
    from.definition.kind === to.definition.kind &&
    from.definition.name === to.definition.name &&
    from.definition.codeTokens.length >= MIN_MOVED_UNIT_TOKENS &&
    to.definition.codeTokens.length >= MIN_MOVED_UNIT_TOKENS
  )
}

function differsOnlyInVisibility(before: Definition, after: Definition): boolean {
  const left = withoutVisibility(before.codeTokens, before.name)
  const right = withoutVisibility(after.codeTokens, after.name)
  return left.length === right.length && left.every((token, index) => token === right[index])
}

/** The tokens with visibility keywords before the definition's name left out. */
function withoutVisibility(tokens: readonly string[], name: string): readonly string[] {
  const nameAt = tokens.indexOf(name)
  if (nameAt === -1) return tokens
  const head: string[] = []
  for (let index = 0; index < nameAt; index++) {
    const token = tokens[index] ?? ""
    if (!VISIBILITY_KEYWORDS.has(token)) {
      head.push(token)
      continue
    }
    if (tokens[index + 1] === RUST_VISIBILITY_GROUP_OPEN) {
      const close = tokens.indexOf(RUST_VISIBILITY_GROUP_CLOSE, index + 1)
      if (close !== -1 && close < nameAt) index = close
    }
  }
  return [...head, ...tokens.slice(nameAt)]
}

interface ScoredPair {
  readonly from: Located
  readonly to: Located
  readonly similarity: number
}

/** Pairs edited moves best match first, removing each matched pair from both arrays. */
function takeMostAlike(froms: Located[], tos: Located[]): [Located, Located][] {
  const scored: ScoredPair[] = froms.flatMap((from) =>
    tos
      .filter((to) => isEditedMoveCandidate(from, to))
      .map((to) => ({ from, to, similarity: tokenSimilarity(from.definition.codeTokens, to.definition.codeTokens) }))
      .filter((pair) => pair.similarity >= MIN_EDITED_MOVE_SIMILARITY),
  )
  scored.sort((a, b) => b.similarity - a.similarity)
  const taken = new Set<Located>()
  const pairs: [Located, Located][] = []
  for (const { from, to } of scored) {
    if (taken.has(from) || taken.has(to)) continue
    taken.add(from)
    taken.add(to)
    pairs.push([from, to])
  }
  removeAll(froms, taken)
  removeAll(tos, taken)
  return pairs
}

function removeAll(items: Located[], taken: ReadonlySet<Located>): void {
  const kept = items.filter((item) => !taken.has(item))
  items.splice(0, items.length, ...kept)
}

/** Pairs elements of `froms` and `tos` one to one, removing each matched pair from both arrays. */
function takeMatches(
  froms: Located[],
  tos: Located[],
  matches: (from: Located, to: Located) => boolean,
): [Located, Located][] {
  const pairs: [Located, Located][] = []
  // The copy is load-bearing: this loop removes from `froms`, and walking it directly would skip items.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const from of [...froms]) {
    const toIndex = tos.findIndex((to) => matches(from, to))
    const to = tos.at(toIndex)
    if (toIndex === -1 || to === undefined) continue
    tos.splice(toIndex, 1)
    froms.splice(froms.indexOf(from), 1)
    pairs.push([from, to])
  }
  return pairs
}

function keyed(definitions: readonly Definition[]): Map<string, Definition> {
  return new Map(definitions.map((definition) => [definition.key, definition]))
}

interface UnitIdentity {
  readonly kind: UnitKind
  readonly name: string
  readonly qualifiedName: string
  readonly facts: null
}

function describe(definition: Definition): UnitIdentity {
  return { kind: definition.kind, name: definition.name, qualifiedName: definition.qualifiedName, facts: null }
}

function locationOf(located: Located): UnitLocation {
  return { path: located.path, qualifiedName: located.definition.qualifiedName }
}

// Module scope first, then in reading order of the file each unit now lives in.
function byPositionInFile(a: ComparedUnit, b: ComparedUnit): number {
  return sortPosition(a) - sortPosition(b)
}

function sortPosition(unit: ComparedUnit): number {
  if (unit.kind === UnitKind.ModuleScope) return 0
  return "after" in unit.change ? unit.change.after.startLine : unit.change.before.startLine
}
