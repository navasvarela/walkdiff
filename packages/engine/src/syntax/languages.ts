import { extname } from "node:path"
import { SourceLanguage } from "@walkdiff/review-model"
import { goSpec } from "./go.ts"
import { javaSpec } from "./java.ts"
import type { LanguageSpec } from "./languageSpec.ts"
import { pythonSpec } from "./python.ts"
import { rustSpec } from "./rust.ts"
import { tsxSpec, typescriptSpec } from "./typescript.ts"

// Plain JavaScript goes through the TSX grammar, which accepts JS and JSX syntax.
const SPEC_BY_EXTENSION: ReadonlyMap<string, LanguageSpec> = new Map([
  [".rs", rustSpec],
  [".ts", typescriptSpec],
  [".mts", typescriptSpec],
  [".cts", typescriptSpec],
  [".tsx", tsxSpec],
  [".js", tsxSpec],
  [".mjs", tsxSpec],
  [".cjs", tsxSpec],
  [".jsx", tsxSpec],
  [".py", pythonSpec],
  [".pyi", pythonSpec],
  [".go", goSpec],
  [".java", javaSpec],
])

export function languageSpecFor(path: string): LanguageSpec | undefined {
  return SPEC_BY_EXTENSION.get(extname(path).toLowerCase())
}

/** Extensions of every language the engine can parse, for narrowing file searches. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [...SPEC_BY_EXTENSION.keys()]

// TypeScript, TSX and plain JavaScript import each other freely; the others stay apart.
const ECMASCRIPT_LANGUAGES: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.TypeScript, SourceLanguage.Tsx])

/** Whether code in one language can refer to units defined in the other. */
export function canReferenceAcross(a: SourceLanguage, b: SourceLanguage): boolean {
  return a === b || (ECMASCRIPT_LANGUAGES.has(a) && ECMASCRIPT_LANGUAGES.has(b))
}
