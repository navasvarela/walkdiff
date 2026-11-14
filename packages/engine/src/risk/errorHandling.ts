import { isTestPath, RiskCategory, RiskSeverity, SourceLanguage } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { languageSpecFor } from "../syntax/languages.ts"
import { withSyntaxTree } from "../syntax/parser.ts"
import { addedLines, findingAt, isThirdParty } from "./scannedFile.ts"
import type { RuleDescription, ScannedFile } from "./scannedFile.ts"

/**
 * Error handling that hides failures, in the code a PR adds: handlers that do nothing, handlers that
 * catch everything, and calls that panic or drop an error. Read from the syntax tree, so a rule only
 * sees what the code says; a handler that only holds a comment is taken as an explained decision.
 */

const SWALLOWED: RuleDescription = {
  id: "errors.swallowed",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Medium,
  title: "Error swallowed",
  detail: "The error is caught and nothing happens: no log, no rethrow, no fallback, so the failure goes unnoticed. Handle it, or say in a comment why ignoring it is right.",
}
const CATCH_ALL: RuleDescription = {
  id: "errors.catch-all",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Low,
  title: "Catches every error",
  detail: "It also catches what shouldn't be handled here, such as an interrupt, running out of memory or a bug in the code it guards. Catch the errors you expect.",
}
const MAY_PANIC: RuleDescription = {
  id: "errors.may-panic",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Low,
  title: "May panic",
  detail: "unwrap() and expect() stop the program when the value is an error or None. Outside tests, return the error with ? or handle it, unless it truly can't happen.",
}
const RESULT_DISCARDED: RuleDescription = {
  id: "errors.result-discarded",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Low,
  title: "Result discarded",
  detail: "Assigning a call to _ throws away what it returns, which in Go is usually an error. Check it, or say why it's safe to drop.",
}

/** One kind of node to look at, and the rule it breaks, if any. */
interface HandlerRule {
  readonly types: readonly string[]
  readonly check: (node: Node) => RuleDescription | undefined
}

const PANICKING_METHODS: ReadonlySet<string> = new Set(["unwrap", "expect"])
const CATCH_ALL_PYTHON = "BaseException"
const CATCH_ALL_JVM = "Throwable"
const CATCH_ALL_CPP = "(...)"
const GO_ERROR_CHECK = /^\s*err\s*!=\s*nil\s*$/
const DISCARD = "_"
const STATEMENT_BLOCK = "statement_block"
const RUST_TEST_MODULE = "tests"
const RUST_TEST_ATTRIBUTE = /#\[(?:tokio::)?test\b/

const CATCH_BODY: HandlerRule = { types: ["catch_clause"], check: (node) => (isEmptyBlock(node.childForFieldName("body")) ? SWALLOWED : undefined) }

const RULES_BY_LANGUAGE: ReadonlyMap<SourceLanguage, readonly HandlerRule[]> = new Map([
  [SourceLanguage.TypeScript, [CATCH_BODY, { types: ["call_expression"], check: emptyPromiseCatch }]],
  [SourceLanguage.Tsx, [CATCH_BODY, { types: ["call_expression"], check: emptyPromiseCatch }]],
  [SourceLanguage.Python, [{ types: ["except_clause"], check: pythonExcept }]],
  [SourceLanguage.Java, [{ types: ["catch_clause"], check: (node) => catchWith(node.childForFieldName("body"), node.namedChildren.find((child) => child?.type === "catch_formal_parameter")?.text, CATCH_ALL_JVM) }]],
  [SourceLanguage.Kotlin, [{ types: ["catch_block"], check: (node) => catchWith(lastChildOfType(node, "block"), node.namedChildren.find((child) => child?.type === "user_type")?.text, CATCH_ALL_JVM) }]],
  [SourceLanguage.CSharp, [CATCH_BODY]],
  [SourceLanguage.Cpp, [{ types: ["catch_clause"], check: (node) => catchWith(node.childForFieldName("body"), node.childForFieldName("parameters")?.text, CATCH_ALL_CPP) }]],
  [SourceLanguage.Go, [{ types: ["if_statement"], check: emptyGoErrorCheck }, { types: ["assignment_statement"], check: discardedGoCall }]],
  [SourceLanguage.Rust, [{ types: ["call_expression"], check: rustPanic }]],
])

export async function scanErrorHandling(files: readonly ScannedFile[]): Promise<Risk[]> {
  const findings: Risk[] = []
  for (const file of files) {
    const spec = languageSpecFor(file.diff.path)
    const rules = spec === undefined ? undefined : RULES_BY_LANGUAGE.get(spec.language)
    if (spec === undefined || rules === undefined || file.after === undefined || isThirdParty(file) || isTestPath(file.diff.path)) continue
    const added = new Set(addedLines(file.diff).map((line) => line.line))
    if (added.size === 0) continue
    const source = file.after
    const lines = source.split("\n")
    findings.push(
      ...(await withSyntaxTree(spec, source, (tree) =>
        rules.flatMap((rule) =>
          tree.rootNode.descendantsOfType([...rule.types]).flatMap((node) => {
            const line = (node?.startPosition.row ?? -1) + 1
            const broken = node === null || !added.has(line) ? undefined : rule.check(node)
            return broken === undefined ? [] : [findingAt(broken, file.diff.path, line, lines.at(line - 1) ?? null)]
          }),
        ),
      )),
    )
  }
  return findings.sort((a, b) => (a.location?.line ?? 0) - (b.location?.line ?? 0))
}

/** A block with no code in it. One holding a comment explains itself, so it isn't counted as empty. */
function isEmptyBlock(block: Node | null | undefined): boolean {
  if (block === null || block === undefined) return false
  const children = block.namedChildren.filter((child): child is Node => child !== null)
  if (children.some((child) => child.type.includes("comment"))) return false
  return children.every(isPlaceholder)
}

// Python's `pass` and `...` say "nothing here" without saying why.
function isPlaceholder(node: Node): boolean {
  if (node.type === "pass_statement" || node.type === "ellipsis") return true
  return node.type === "expression_statement" && node.namedChildren.every((child) => child?.type === "ellipsis")
}

function catchWith(body: Node | null | undefined, caught: string | undefined, catchAll: string): RuleDescription | undefined {
  if (isEmptyBlock(body)) return SWALLOWED
  return caught?.includes(catchAll) === true ? CATCH_ALL : undefined
}

function lastChildOfType(node: Node, type: string): Node | undefined {
  return node.namedChildren.filter((child): child is Node => child?.type === type).at(-1)
}

function pythonExcept(node: Node): RuleDescription | undefined {
  const block = lastChildOfType(node, "block")
  if (isEmptyBlock(block)) return SWALLOWED
  const caught = node.namedChildren.filter((child): child is Node => child !== null && child.type !== "block" && !child.type.includes("comment"))
  const isBare = caught.length === 0
  return isBare || caught.some((child) => child.text === CATCH_ALL_PYTHON) ? CATCH_ALL : undefined
}

// `promise.catch(() => {})`.
function emptyPromiseCatch(node: Node): RuleDescription | undefined {
  const callee = node.childForFieldName("function")
  if (callee?.type !== "member_expression" || callee.childForFieldName("property")?.text !== "catch") return undefined
  const handler = node.childForFieldName("arguments")?.firstNamedChild
  const isFunction = handler?.type === "arrow_function" || handler?.type === "function_expression"
  // `() => undefined` or `() => fallback` returns a value on purpose; only an empty `{}` does nothing.
  const body = handler?.childForFieldName("body")
  return isFunction && body?.type === STATEMENT_BLOCK && isEmptyBlock(body) ? SWALLOWED : undefined
}

function emptyGoErrorCheck(node: Node): RuleDescription | undefined {
  const condition = node.childForFieldName("condition")?.text ?? ""
  const hasElse = node.childForFieldName("alternative") !== null
  return GO_ERROR_CHECK.test(condition) && !hasElse && isEmptyBlock(node.childForFieldName("consequence")) ? SWALLOWED : undefined
}

// `_ = f.Close()`: only a call's result, as `_ = x` is how Go silences an unused variable.
function discardedGoCall(node: Node): RuleDescription | undefined {
  const left = node.childForFieldName("left")
  const right = node.childForFieldName("right")
  return left?.text === DISCARD && right?.namedChildren.length === 1 && right.firstNamedChild?.type === "call_expression" ? RESULT_DISCARDED : undefined
}

function rustPanic(node: Node): RuleDescription | undefined {
  const callee = node.childForFieldName("function")
  const method = callee?.type === "field_expression" ? callee.childForFieldName("field")?.text : undefined
  return method !== undefined && PANICKING_METHODS.has(method) && !isInRustTest(node) ? MAY_PANIC : undefined
}

function isInRustTest(node: Node): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type === "mod_item" && ancestor.childForFieldName("name")?.text === RUST_TEST_MODULE) return true
    if (ancestor.type === "function_item" && RUST_TEST_ATTRIBUTE.test(ancestor.previousNamedSibling?.text ?? "")) return true
  }
  return false
}
