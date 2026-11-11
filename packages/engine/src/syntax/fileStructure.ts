import { isBehaviourChange, UnitKind } from "@walkdiff/review-model"
import type { ComparedUnit, OutlineEntry, UnitCall } from "@walkdiff/review-model"
import { containerTypeName, simpleTypeName } from "../impact/traceImpact.ts"
import type { FileUnits } from "./definitions.ts"

// Names of what can be called, used to tell a call to `parse` from a block named `parse`.
const NOT_CALLABLE: ReadonlySet<UnitKind> = new Set([UnitKind.ModuleScope, UnitKind.Impl, UnitKind.Module, UnitKind.TestSuite, UnitKind.Test, UnitKind.TestHook])
// Read as code, in file order with helpers first, rather than among the type definitions.
const CODE_KINDS: ReadonlySet<UnitKind> = new Set([UnitKind.Function, UnitKind.Method, UnitKind.TestSuite, UnitKind.Test, UnitKind.TestHook])

const RUST_PATH_SEPARATOR = "::"

const ReadingGroup = { ModuleScope: 0, Definitions: 1, Functions: 2, Quiet: 3 } as const
type ReadingGroup = (typeof ReadingGroup)[keyof typeof ReadingGroup]

export function outlineOf(after: FileUnits | undefined): OutlineEntry[] {
  return (after?.definitions ?? []).map((definition) => ({
    kind: definition.kind,
    qualifiedName: definition.qualifiedName,
    startLine: definition.snapshot.startLine,
    endLine: definition.snapshot.endLine,
  }))
}

/**
 * Which changed units call which, within one file. Matched by name, not type resolution: a
 * name shared by two changed units links to neither, since a wrong arrow would mislead more
 * than a missing one.
 */
export function unitCalls(after: FileUnits | undefined, units: readonly ComparedUnit[]): UnitCall[] {
  const calleesByName = new Map<string, string[]>()
  for (const unit of units) {
    if (NOT_CALLABLE.has(unit.kind)) continue
    calleesByName.set(unit.name, [...(calleesByName.get(unit.name) ?? []), unit.qualifiedName])
  }
  const changed = new Set(units.map((unit) => unit.qualifiedName))
  const calls: UnitCall[] = []
  for (const definition of after?.definitions ?? []) {
    if (definition.shape === undefined || !changed.has(definition.qualifiedName)) continue
    const linked = new Set<string>()
    for (const call of definition.shape.calls) {
      const candidates = calleesByName.get(lastSegment(call)) ?? []
      const callee = candidates.at(0)
      if (candidates.length !== 1 || callee === undefined || callee === definition.qualifiedName) continue
      if (pathNamesAnotherType(call, callee)) continue
      linked.add(callee)
    }
    for (const callee of linked) {
      calls.push({ caller: definition.qualifiedName, callee })
    }
  }
  return calls
}

/**
 * Orders units for reading: top-level code, then types, then functions with helpers before
 * their callers, and changes that leave behaviour alone last. Otherwise keeps file order.
 */
export function orderUnits<Unit extends ComparedUnit>(units: readonly Unit[], calls: readonly UnitCall[]): Unit[] {
  const callees = new Map<string, string[]>()
  for (const call of calls) {
    callees.set(call.caller, [...(callees.get(call.caller) ?? []), call.callee])
  }
  const byName = new Map(units.map((unit) => [unit.qualifiedName, unit]))
  const ordered: Unit[] = []
  const visited = new Set<Unit>()
  // Depth first, so each unit comes after what it calls; `visited` also breaks call cycles.
  const visit = (unit: Unit): void => {
    if (visited.has(unit)) return
    visited.add(unit)
    for (const name of callees.get(unit.qualifiedName) ?? []) {
      const callee = byName.get(name)
      if (callee !== undefined && readingGroup(callee) === readingGroup(unit)) visit(callee)
    }
    ordered.push(unit)
  }
  const groups = [ReadingGroup.ModuleScope, ReadingGroup.Definitions, ReadingGroup.Functions, ReadingGroup.Quiet]
  for (const group of groups) {
    units.filter((unit) => readingGroup(unit) === group).forEach(visit)
  }
  return ordered
}

function readingGroup(unit: ComparedUnit): ReadingGroup {
  if (unit.kind === UnitKind.ModuleScope) return ReadingGroup.ModuleScope
  if (!isBehaviourChange(unit.change)) return ReadingGroup.Quiet
  return CODE_KINDS.has(unit.kind) ? ReadingGroup.Functions : ReadingGroup.Definitions
}

/** `Other::new` is not a call to `Size::new`, though both are named `new`. */
function pathNamesAnotherType(call: string, callee: string): boolean {
  const separator = call.lastIndexOf(RUST_PATH_SEPARATOR)
  const container = containerTypeName(callee, RUST_PATH_SEPARATOR)
  if (separator === -1 || container === undefined) return false
  const qualifier = simpleTypeName(call.slice(0, separator))
  return qualifier !== container && qualifier !== "Self"
}

// `self.cache.get` and `util::parse` call `get` and `parse`; `panic!` is the macro `panic`.
function lastSegment(call: string): string {
  return call.replace(/!$/, "").split(/::|\.|->/).at(-1) ?? call
}
