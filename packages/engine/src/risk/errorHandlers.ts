import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import type { RuleDescription } from "./scannedFile.ts"

/**
 * The parts of the error-handling rules that languages share: what each finding says, and how to
 * tell an empty handler. Each language lists the syntax nodes to look at and how to judge them.
 */

export const SWALLOWED: RuleDescription = {
  id: "errors.swallowed",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Medium,
  title: "Error swallowed",
  detail: "The error is caught and nothing happens: no log, no rethrow, no fallback, so the failure goes unnoticed. Handle it, or say in a comment why ignoring it is right.",
}
export const CATCH_ALL: RuleDescription = {
  id: "errors.catch-all",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Low,
  title: "Catches every error",
  detail: "It also catches what shouldn't be handled here, such as an interrupt, running out of memory or a bug in the code it guards. Catch the errors you expect.",
}
export const MAY_PANIC: RuleDescription = {
  id: "errors.may-panic",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Low,
  title: "May panic",
  detail: "unwrap() and expect() stop the program when the value is an error or None. Outside tests, return the error with ? or handle it, unless it truly can't happen.",
}
export const RESULT_DISCARDED: RuleDescription = {
  id: "errors.result-discarded",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Low,
  title: "Result discarded",
  detail: "Assigning a call to _ throws away what it returns, which in Go is usually an error. Check it, or say why it's safe to drop.",
}

/** One kind of node to look at, and the rule it breaks, if any. */
export interface HandlerRule {
  readonly types: readonly string[]
  readonly check: (node: Node) => RuleDescription | undefined
}

/** `catch (e) { }` in grammars that name the handler's block `body`. */
export const EMPTY_CATCH_BODY: HandlerRule = { types: ["catch_clause"], check: (node) => (isEmptyBlock(node.childForFieldName("body")) ? SWALLOWED : undefined) }

/** A block with no code in it. One holding a comment explains itself, so it isn't counted as empty. */
export function isEmptyBlock(block: Node | null | undefined): boolean {
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

/** A handler that does nothing, or one whose caught type names the language's catch-all. */
export function catchWith(body: Node | null | undefined, caught: string | undefined, catchAll: string): RuleDescription | undefined {
  if (isEmptyBlock(body)) return SWALLOWED
  return caught?.includes(catchAll) === true ? CATCH_ALL : undefined
}

export function lastChildOfType(node: Node, type: string): Node | undefined {
  return node.namedChildren.filter((child): child is Node => child?.type === type).at(-1)
}
