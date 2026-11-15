import type { ApiRule } from "../risk/apiRules.ts"
import type { LibrarySurfaceReader } from "../risk/breaking/librarySurface.ts"
import type { HandlerRule } from "../risk/errorHandlers.ts"
import type { RouteSyntax } from "../risk/routeSyntax.ts"
import type { LanguageSpec } from "../syntax/languageSpec.ts"

/**
 * Everything the engine knows about one language, in one place: how to parse it, which files are
 * written in it, and the rules each check applies to it. Adding a language means writing one of these
 * and listing it in `registry.ts`; a check that has no rules for a language leaves its list empty.
 */
export interface Language {
  /** How people name it in the report, such as "C#". Languages may share one, as TypeScript and TSX do. */
  readonly name: string
  readonly spec: LanguageSpec
  /** Lower-case, with the dot: `.rs`. */
  readonly extensions: readonly string[]
  /**
   * Languages with the same family can refer to each other's units, as TypeScript and plain
   * JavaScript do, or C and C++ through shared headers. Undefined keeps the language to itself.
   */
  readonly family?: string
  /** Risky APIs, flagged on added lines outside comments and strings. */
  readonly riskyApis: readonly ApiRule[]
  /** Error handling that hides failures, read from the syntax tree. */
  readonly errorHandlers: readonly HandlerRule[]
  /** How its web frameworks declare HTTP routes. */
  readonly routes: readonly RouteSyntax[]
  /** Which changed files other projects can import; without it, public API checks don't run. */
  readonly librarySurface?: LibrarySurfaceReader
}
