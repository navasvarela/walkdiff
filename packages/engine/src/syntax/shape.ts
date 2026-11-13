import type { UnitFacts } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { declaredName } from "./declarators.ts"
import { ParameterKind } from "./languageSpec.ts"
import type { CallSyntax, ShapeGrammar } from "./languageSpec.ts"

/** A function's outward form and control flow, enough to state what an edit changed. */
export interface UnitShape {
  /** Parameter name → its full text, so a changed type or default shows under the same name. */
  readonly parameters: ReadonlyMap<string, string>
  /** The same parameters in order, with what a caller must supply for each. */
  readonly signature: readonly SignatureParameter[]
  readonly returnType: string | null
  readonly calls: ReadonlySet<string>
  readonly errorPaths: number
  readonly branches: number
  readonly metrics: FunctionMetrics
}

export interface SignatureParameter {
  readonly name: string
  readonly kind: ParameterKind
  /** The declared type; null where the parameter has none. */
  readonly type: string | null
}

/** How hard a function is to read, for spotting when a change makes one worse. */
export interface FunctionMetrics {
  /** Cyclomatic complexity: one path through the function, plus one per decision point. */
  readonly complexity: number
  /** The deepest level of nested control flow. */
  readonly nesting: number
  readonly lines: number
  /** Declared parameters, not counting a `self` or `cls` receiver. */
  readonly parameters: number
}

// Longer callee text is usually a chained expression; its last segment says more.
const MAX_CALLEE_TEXT = 40
const LAST_SEGMENT = /[\p{L}\p{N}_$]+$/u
// `self`, `&self`, `&mut self` and `cls` are how a method is called, not something a caller passes.
const RECEIVER_PARAMETER = /\b(self|cls)$|^this$/
const NO_PARAMETERS = "void"
// Kotlin's parameter node, which names its parameter without a field.
const UNNAMED_PARAMETER = "parameter"

export function extractShape(grammar: ShapeGrammar, definition: Node): UnitShape {
  const fn = grammar.functionNode(definition)
  const calls = callNames(grammar, fn)
  const bailOuts = calls.list.filter((name) => grammar.errorCalls.has(name)).length
  const slots = grammar.parameters(fn).flatMap(parameterSlots)
  const parameters = new Map(slots.map((slot) => [slot.name, slot.text]))
  const branches = fn.descendantsOfType([...grammar.branchTypes]).length
  return {
    parameters,
    signature: slots.map((slot) => signatureParameter(grammar, slot)),
    // TypeScript's return type node includes its leading colon.
    returnType: typeText(grammar.returnType(fn)),
    calls: new Set(calls.list),
    errorPaths: fn.descendantsOfType([...grammar.errorTypes]).length + bailOuts,
    branches,
    metrics: {
      complexity: 1 + branches + logicalOperatorCount(grammar, fn),
      nesting: deepestNesting(grammar, fn),
      lines: fn.endPosition.row - fn.startPosition.row + 1,
      parameters: [...parameters.keys()].filter((name) => !RECEIVER_PARAMETER.test(name)).length,
    },
  }
}

function logicalOperatorCount(grammar: ShapeGrammar, fn: Node): number {
  return fn.descendantsOfType([...grammar.logicalTypes]).filter((node) => {
    const operator = node?.childForFieldName("operator")?.text
    return operator !== undefined && grammar.logicalOperators.has(operator)
  }).length
}

function deepestNesting(grammar: ShapeGrammar, fn: Node): number {
  const nestingTypes = new Set(grammar.nestingTypes)
  const depths = fn.descendantsOfType(grammar.nestingTypes.slice()).map((node) => (node === null ? 0 : nestingDepth(node, fn, nestingTypes)))
  return Math.max(0, ...depths)
}

function nestingDepth(node: Node, fn: Node, nestingTypes: ReadonlySet<string>): number {
  let depth = 0
  for (let current: Node | null = node; current !== null && current.id !== fn.id; current = current.parent) {
    // `else if` reads as a sibling of its `if`, though the syntax tree nests it inside the `else`.
    if (nestingTypes.has(current.type) && current.parent?.type !== "else_clause") depth++
  }
  return depth
}

/** The facts between two versions, or null when an edit changes none of them. */
export function factsBetween(before: UnitShape, after: UnitShape): UnitFacts | null {
  const facts: UnitFacts = {
    parametersAdded: [...after.parameters.keys()].filter((name) => !before.parameters.has(name)),
    parametersRemoved: [...before.parameters.keys()].filter((name) => !after.parameters.has(name)),
    parametersChanged: [...after.parameters].filter(([name, text]) => before.parameters.has(name) && before.parameters.get(name) !== text).map(([name]) => name),
    returnType: before.returnType === after.returnType ? null : { before: before.returnType, after: after.returnType },
    callsAdded: [...after.calls].filter((call) => !before.calls.has(call)),
    callsRemoved: [...before.calls].filter((call) => !after.calls.has(call)),
    errorPathsDelta: after.errorPaths - before.errorPaths,
    branchesDelta: after.branches - before.branches,
    complexity: before.metrics.complexity === after.metrics.complexity ? null : { before: before.metrics.complexity, after: after.metrics.complexity },
  }
  const hasAny =
    facts.parametersAdded.length + facts.parametersRemoved.length + facts.parametersChanged.length + facts.callsAdded.length + facts.callsRemoved.length > 0 ||
    facts.returnType !== null ||
    facts.complexity !== null ||
    facts.errorPathsDelta !== 0 ||
    facts.branchesDelta !== 0
  return hasAny ? facts : null
}

/** The parameters in the function's `parameters` field, or the single `parameter` of `x => x + 1`. */
export function parametersByField(fn: Node): Node[] {
  const list = fn.childForFieldName("parameters")
  // `x => x + 1` has a single parameter and no list around it.
  const single = fn.childForFieldName("parameter")
  const nodes = list === null ? (single === null ? [] : [single]) : list.namedChildren
  // C's `int f(void)` takes no parameters.
  return nodes.filter((node): node is Node => node !== null && !node.type.includes("comment") && node.text !== NO_PARAMETERS)
}

/** Reads the return type from a field of the function's node. */
export function returnTypeByField(field: string): (fn: Node) => Node | null {
  return (fn) => fn.childForFieldName(field)
}

/** One name a caller passes, with the declaration it's in. */
interface ParameterSlot {
  readonly name: string
  readonly text: string
  readonly node: Node
}

// Go declares `a, b int` once for both names, and each is a parameter of its own to callers.
function parameterSlots(node: Node): ParameterSlot[] {
  const names = node.childrenForFieldName("name").filter((name): name is Node => name !== null)
  if (names.length < 2) return [{ name: squeeze(parameterName(node)), text: squeeze(node.text), node }]
  const type = node.childForFieldName("type")?.text ?? ""
  return names.map((name) => ({ name: name.text, text: squeeze(`${name.text} ${type}`), node }))
}

function signatureParameter(grammar: ShapeGrammar, slot: ParameterSlot): SignatureParameter {
  const name = slot.name.replace(/^\*+/, "")
  const kind = RECEIVER_PARAMETER.test(name) ? ParameterKind.Receiver : grammar.parameterKind(slot.node)
  return { name, kind, type: typeText(slot.node.childForFieldName("type")) }
}

function typeText(node: Node | null): string | null {
  return squeeze(node?.text ?? "").replace(/^:\s*/, "") || null
}

function parameterName(node: Node): string {
  // Java's `String... rest` names its parameter in a declarator, and C's `char *name` in a chain of them.
  const named = node.childForFieldName("pattern") ?? node.childForFieldName("name") ?? declaratorName(node) ?? declaredName(node)?.nameNode ?? null
  if (named !== null) return named.text
  // Python's `typed_parameter` and Kotlin's `parameter` have no name field: the name is their first identifier.
  if (!node.type.includes("typed") && node.type !== UNNAMED_PARAMETER) return node.text
  return node.namedChildren.find((child) => child?.type === "identifier")?.text ?? node.firstNamedChild?.text ?? node.text
}

function declaratorName(node: Node): Node | null {
  return node.namedChildren.find((child) => child?.type === "variable_declarator")?.childForFieldName("name") ?? null
}

interface CallNames {
  /** With repeats, so repeated bail-outs each count as an error path. */
  readonly list: readonly string[]
}

function callNames(grammar: ShapeGrammar, fn: Node): CallNames {
  const list = fn.descendantsOfType([...grammar.calls.keys()]).flatMap((call) => {
    const syntax = call === null ? undefined : grammar.calls.get(call.type)
    const callee = syntax === undefined || call === null ? null : calleeOf(call, syntax)
    const name = callee === null ? undefined : calleeName(callee)
    return syntax === undefined || name === undefined ? [] : [`${name}${syntax.suffix}`]
  })
  return { list }
}

function calleeOf(call: Node, syntax: CallSyntax): Node | null {
  return syntax.calleeField === undefined ? call.firstNamedChild : call.childForFieldName(syntax.calleeField)
}

// Undefined for a function called where it's written, such as Go's `go func() {…}()` or
// JavaScript's `(() => {…})()`: it has no name, and its own calls are counted already.
function calleeName(callee: Node): string | undefined {
  // Chained calls span lines; `items\n  .iter` is the callee `items.iter`.
  const text = callee.text.replace(/\s+/g, "")
  if (text.length <= MAX_CALLEE_TEXT && !text.includes("(")) return text
  return LAST_SEGMENT.exec(text)?.[0]
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
