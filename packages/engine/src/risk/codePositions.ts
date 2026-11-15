import type { Tree } from "web-tree-sitter"

/**
 * Whether the text at a position is part of a comment or string literal rather than code, so a
 * pattern matched on a line only counts where it's code. Interpolations inside template strings
 * (`${...}`) are code again.
 */
export function isInsideCommentOrString(tree: Tree, row: number, column: number): boolean {
  for (let node = tree.rootNode.descendantForPosition({ row, column }); node !== null; node = node.parent) {
    if (node.type === "template_substitution" || node.type === "interpolation") return false
    if (node.type.includes("comment") || node.type.includes("string")) return true
  }
  return false
}
