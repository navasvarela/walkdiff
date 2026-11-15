import { isTestPath } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { languageFor } from "../languages/registry.ts"
import { withSyntaxTree } from "../syntax/parser.ts"
import { addedLines, findingAt, isThirdParty } from "./scannedFile.ts"
import type { ScannedFile } from "./scannedFile.ts"

/**
 * Error handling that hides failures, in the code a PR adds: handlers that do nothing, handlers that
 * catch everything, and calls that panic or drop an error. Read from the syntax tree, so a rule only
 * sees what the code says; a handler that only holds a comment is taken as an explained decision.
 * Each language lists the nodes to look at in its `errorHandlers`.
 */

export async function scanErrorHandling(files: readonly ScannedFile[]): Promise<Risk[]> {
  const findings: Risk[] = []
  for (const file of files) {
    const language = languageFor(file.diff.path)
    const rules = language?.errorHandlers ?? []
    if (language === undefined || rules.length === 0 || file.after === undefined || isThirdParty(file) || isTestPath(file.diff.path)) continue
    const added = new Set(addedLines(file.diff).map((line) => line.line))
    if (added.size === 0) continue
    const source = file.after
    const lines = source.split("\n")
    findings.push(
      ...(await withSyntaxTree(language.spec, source, (tree) =>
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
