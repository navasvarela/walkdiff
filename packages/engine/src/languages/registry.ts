import { extname } from "node:path"
import type { SourceLanguage } from "@walkdiff/review-model"
import type { LanguageSpec } from "../syntax/languageSpec.ts"
import { C, CPP } from "./cFamily.ts"
import { CSHARP } from "./csharp.ts"
import { GO } from "./go.ts"
import { JAVA } from "./java.ts"
import { KOTLIN } from "./kotlin.ts"
import type { Language } from "./language.ts"
import { PYTHON } from "./python.ts"
import { RUST } from "./rust.ts"
import { TSX, TYPESCRIPT } from "./typescript.ts"

/** Every language the engine reads, in the order the report names them. */
export const LANGUAGES: readonly Language[] = [RUST, TYPESCRIPT, TSX, PYTHON, GO, JAVA, KOTLIN, CSHARP, C, CPP]

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, Language> = new Map(LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language] as const)))
const LANGUAGE_BY_ID: ReadonlyMap<SourceLanguage, Language> = new Map(LANGUAGES.map((language) => [language.spec.language, language] as const))

export function languageFor(path: string): Language | undefined {
  return LANGUAGE_BY_EXTENSION.get(extname(path).toLowerCase())
}

export function languageSpecFor(path: string): LanguageSpec | undefined {
  return languageFor(path)?.spec
}

/** Extensions of every language the engine can parse, for narrowing file searches. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [...LANGUAGE_BY_EXTENSION.keys()]

/** Whether code in one language can refer to units defined in the other. */
export function canReferenceAcross(a: SourceLanguage, b: SourceLanguage): boolean {
  if (a === b) return true
  const family = LANGUAGE_BY_ID.get(a)?.family
  return family !== undefined && LANGUAGE_BY_ID.get(b)?.family === family
}

/** The names of the languages that pass `test`, as a reader would list them: "Rust, Python and Go". */
export function namesOfLanguages(test: (language: Language) => boolean): string {
  const names = [...new Set(LANGUAGES.filter(test).map((language) => language.name))]
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`
}
