import { UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import type { DefinitionHeader } from "./languageSpec.ts"

/**
 * Recognises the calls JavaScript and TypeScript test frameworks define tests with: Jest, Vitest,
 * Mocha, Jasmine, node:test and Playwright all spell them `describe`, `it`, `test` and the hooks,
 * with modifiers such as `.only`, `.each(table)` or `.skipIf(cond)`. Matching by name means a
 * function of one's own called `describe` is taken for a suite, which is rare enough to accept.
 */
type TestKind = typeof UnitKind.TestSuite | typeof UnitKind.Test | typeof UnitKind.TestHook

const KIND_BY_WORD: ReadonlyMap<string, TestKind> = new Map([
  ["describe", UnitKind.TestSuite],
  ["suite", UnitKind.TestSuite],
  ["context", UnitKind.TestSuite],
  ["fdescribe", UnitKind.TestSuite],
  ["xdescribe", UnitKind.TestSuite],
  ["it", UnitKind.Test],
  ["test", UnitKind.Test],
  ["specify", UnitKind.Test],
  ["fit", UnitKind.Test],
  ["xit", UnitKind.Test],
  ["beforeEach", UnitKind.TestHook],
  ["afterEach", UnitKind.TestHook],
  ["beforeAll", UnitKind.TestHook],
  ["afterAll", UnitKind.TestHook],
  ["before", UnitKind.TestHook],
  ["after", UnitKind.TestHook],
])
const MODIFIERS: ReadonlySet<string> = new Set(["only", "skip", "todo", "concurrent", "sequential", "fails", "each", "skipIf", "runIf", "serial", "parallel", "fixme"])
const CALLBACK_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression"])
const TITLE_TYPES: ReadonlySet<string> = new Set(["string", "template_string"])

interface TestCall {
  readonly kind: TestKind
  /** The words naming the call, modifiers left out: `test.describe.only` is `test describe`. */
  readonly words: readonly string[]
  readonly title: Node | undefined
  readonly callback: Node
}

/** A statement such as `describe("parser", () => {…})`, as a unit. */
export function describeTestStatement(statement: Node): DefinitionHeader | undefined {
  const call = statement.type === "expression_statement" ? testCall(statement.namedChildren.at(0) ?? null) : undefined
  if (call === undefined) return undefined
  if (call.kind === UnitKind.TestHook || call.title === undefined) return { kind: call.kind, name: call.words.join("."), nameNode: null }
  return { kind: call.kind, name: titleText(call.title), nameNode: titleNameNode(call.title) }
}

/**
 * Whether a node the walker would otherwise skip leads into a suite's callback, where its tests
 * are: the suite's call, the callback passed to it, and the callback's body.
 */
export function leadsIntoTestSuite(node: Node): boolean {
  if (node.type === "call_expression") return testCall(node)?.kind === UnitKind.TestSuite
  if (CALLBACK_TYPES.has(node.type)) return isSuiteCallback(node)
  const parent = node.parent
  return node.type === "statement_block" && parent !== null && CALLBACK_TYPES.has(parent.type) && isSuiteCallback(parent)
}

function isSuiteCallback(callback: Node): boolean {
  const call = callback.parent?.parent ?? null
  return callback.parent?.type === "arguments" && testCall(call)?.callback.id === callback.id && testCall(call)?.kind === UnitKind.TestSuite
}

function testCall(node: Node | null): TestCall | undefined {
  if (node?.type !== "call_expression") return undefined
  const words = calleeWords(node.childForFieldName("function"))
  const kind = KIND_BY_WORD.get(words.at(-1) ?? "")
  if (kind === undefined || !KIND_BY_WORD.has(words.at(0) ?? "")) return undefined
  const args = node.childForFieldName("arguments")?.namedChildren.filter((arg) => arg !== null) ?? []
  const callback = args.find((arg) => CALLBACK_TYPES.has(arg.type))
  if (callback === undefined) return undefined
  const first = args.at(0)
  return { kind, words, title: first === undefined || first.id === callback.id ? undefined : first, callback }
}

// `describe.each(table)` and `it.skipIf(cond)` are calls that return the function then called.
function calleeWords(callee: Node | null): string[] {
  if (callee === null) return []
  if (callee.type === "identifier") return [callee.text]
  if (callee.type === "call_expression") return calleeWords(callee.childForFieldName("function"))
  if (callee.type !== "member_expression") return []
  const property = callee.childForFieldName("property")?.text ?? ""
  const object = calleeWords(callee.childForFieldName("object"))
  return MODIFIERS.has(property) ? object : [...object, property]
}

function titleText(title: Node): string {
  return TITLE_TYPES.has(title.type) ? title.text.slice(1, -1) : title.text
}

// Rename detection masks the leaf holding the name, so a retitled test with the same body is a rename.
function titleNameNode(title: Node): Node | null {
  const fragments = title.namedChildren.filter((child) => child?.type === "string_fragment")
  return fragments.length === 1 ? (fragments.at(0) ?? null) : null
}
