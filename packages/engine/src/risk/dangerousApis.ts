import type { Risk } from "@walkdiff/review-model"
import type { Tree } from "web-tree-sitter"
import { languageFor } from "../languages/registry.ts"
import { withSyntaxTree } from "../syntax/parser.ts"
import type { ApiRule } from "./apiRules.ts"
import { isInsideCommentOrString } from "./codePositions.ts"
import { addedLines, findingAt, isThirdParty } from "./scannedFile.ts"
import type { AddedLine, ScannedFile } from "./scannedFile.ts"


/**
 * Flags risky API uses on added lines of supported languages. A match only counts when it
 * is code: the parsed head file tells comments and strings apart from calls.
 */
export async function scanDangerousApis(files: readonly ScannedFile[]): Promise<Risk[]> {
  const findings: Risk[] = []
  for (const file of files) {
    const language = languageFor(file.diff.path)
    const rules = language?.riskyApis ?? []
    const lines = addedLines(file.diff)
    if (language === undefined || file.after === undefined || isThirdParty(file) || rules.length === 0 || lines.length === 0) continue
    const source = file.after
    findings.push(...(await withSyntaxTree(language.spec, source, (tree) => matchRules(tree, rules, lines, file.diff.path))))
  }
  return findings
}

function matchRules(tree: Tree, rules: readonly ApiRule[], lines: readonly AddedLine[], path: string): Risk[] {
  const findings: Risk[] = []
  for (const { line, content } of lines) {
    for (const apiRule of rules) {
      const match = apiRule.pattern.exec(content)
      if (match === null || apiRule.safeWhen?.test(content) || isInsideCommentOrString(tree, line - 1, match.index)) continue
      findings.push(findingAt(apiRule, path, line, content))
    }
  }
  return findings
}
