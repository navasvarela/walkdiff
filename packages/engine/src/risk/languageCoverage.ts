import { extname } from "node:path"
import { SourceLanguage } from "@walkdiff/review-model"
import type { SkippedCheck } from "@walkdiff/review-model"
import { languageSpecFor } from "../syntax/languages.ts"

// Code the engine doesn't parse: only the secret and sensitive-path rules read it.
const UNPARSED_CODE_EXTENSIONS: ReadonlySet<string> = new Set([".rb", ".php", ".swift", ".scala", ".sh"])
// Breaking changes need a language's rules for what a library exposes, which these don't have yet.
const WITHOUT_PUBLIC_API_RULES: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Java, SourceLanguage.Kotlin, SourceLanguage.CSharp, SourceLanguage.C, SourceLanguage.Cpp])

/** The checks that can't read some of the changed files, because of the language they're in. */
export function languageGaps(paths: readonly string[]): SkippedCheck[] {
  const unparsed = extensionsOf(paths.filter(isUnparsedCode))
  const withoutApiRules = extensionsOf(paths.filter((path) => isUnparsedCode(path) || hasNoPublicApiRules(path)))
  const gaps: SkippedCheck[] = []
  if (unparsed.length > 0) {
    gaps.push({ check: `Dangerous-API rules for ${unparsed.join(", ")} files`, reason: "rules exist only for Rust, TypeScript/JavaScript, Python, Go, Java, Kotlin, C#, C and C++" })
  }
  if (withoutApiRules.length > 0) {
    gaps.push({ check: `Public API checks for ${withoutApiRules.join(", ")} files`, reason: "they exist only for Rust, TypeScript/JavaScript, Python and Go" })
  }
  return gaps
}

function isUnparsedCode(path: string): boolean {
  return UNPARSED_CODE_EXTENSIONS.has(extname(path))
}

function hasNoPublicApiRules(path: string): boolean {
  const language = languageSpecFor(path)?.language
  return language !== undefined && WITHOUT_PUBLIC_API_RULES.has(language)
}

function extensionsOf(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => extname(path)))]
}
