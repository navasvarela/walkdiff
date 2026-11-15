import { extname } from "node:path"
import type { SkippedCheck } from "@walkdiff/review-model"
import { languageFor, namesOfLanguages } from "../languages/registry.ts"

// Breaking changes need a language's rules for what a library exposes (its `librarySurface`).
// Code the engine doesn't parse: only the secret and sensitive-path rules read it.
const UNPARSED_CODE_EXTENSIONS: ReadonlySet<string> = new Set([".rb", ".php", ".swift", ".scala", ".sh"])

/** The checks that can't read some of the changed files, because of the language they're in. */
export function languageGaps(paths: readonly string[]): SkippedCheck[] {
  const unparsed = extensionsOf(paths.filter(isUnparsedCode))
  const withoutApiRules = extensionsOf(paths.filter((path) => isUnparsedCode(path) || hasNoPublicApiRules(path)))
  const gaps: SkippedCheck[] = []
  if (unparsed.length > 0) {
    gaps.push({ check: `Dangerous-API rules for ${unparsed.join(", ")} files`, reason: `rules exist only for ${namesOfLanguages((language) => language.riskyApis.length > 0)}` })
  }
  if (withoutApiRules.length > 0) {
    gaps.push({ check: `Public API checks for ${withoutApiRules.join(", ")} files`, reason: `they exist only for ${namesOfLanguages((language) => language.librarySurface !== undefined)}` })
  }
  return gaps
}

function isUnparsedCode(path: string): boolean {
  return UNPARSED_CODE_EXTENSIONS.has(extname(path))
}

function hasNoPublicApiRules(path: string): boolean {
  const language = languageFor(path)
  return language !== undefined && language.librarySurface === undefined
}

function extensionsOf(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => extname(path)))]
}
