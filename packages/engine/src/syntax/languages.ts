import { extname } from "node:path"
import { SourceLanguage } from "@walkdiff/review-model"
import { cppSpec, cSpec } from "./cFamily.ts"
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
  [".c", cSpec],
  // A `.h` header may be C or C++. The C++ grammar reads both, short of C code using a C++
  // keyword such as `new` as a name; the C grammar would drop every class in a C++ header.
  [".h", cppSpec],
  [".cc", cppSpec],
  [".cpp", cppSpec],
  [".cxx", cppSpec],
  [".c++", cppSpec],
  [".hh", cppSpec],
  [".hpp", cppSpec],
  [".hxx", cppSpec],
  [".h++", cppSpec],
  [".inl", cppSpec],
  [".ipp", cppSpec],
  [".tpp", cppSpec],
])

export function languageSpecFor(path: string): LanguageSpec | undefined {
  return SPEC_BY_EXTENSION.get(extname(path).toLowerCase())
}

/** Extensions of every language the engine can parse, for narrowing file searches. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [...SPEC_BY_EXTENSION.keys()]

// TypeScript, TSX and plain JavaScript import each other freely, and C and C++ share headers;
// the others stay apart.
const LANGUAGE_FAMILIES: readonly ReadonlySet<SourceLanguage>[] = [
  new Set([SourceLanguage.TypeScript, SourceLanguage.Tsx]),
  new Set([SourceLanguage.C, SourceLanguage.Cpp]),
]

/** Whether code in one language can refer to units defined in the other. */
export function canReferenceAcross(a: SourceLanguage, b: SourceLanguage): boolean {
  return a === b || LANGUAGE_FAMILIES.some((family) => family.has(a) && family.has(b))
}
