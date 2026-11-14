import { isTestKind } from "./queries.ts"
import { UnitKind } from "./schema.ts"

/**
 * One rule, shared by the engine and the report, for what counts as test code. Checks that judge
 * production code (function metrics, breaking changes, "no tests changed") leave it out, and the
 * review path puts it last.
 */

const TEST_PATHS: readonly RegExp[] = [
  // Folders test runners look in, in any case: Java's `src/test`, Swift's `Tests`, Jest's `__tests__`.
  /(^|\/)(tests?|__tests__|specs?|testing)\//i,
  // `parser.test.ts`, `parser_test.go`, `store_test.cc`, `server-spec.rb`.
  /[._-](test|spec)\.[a-z0-9+]+$/i,
  // pytest's `test_parser.py`, and Rust's `tests.rs` module file.
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)tests?\.rs$/,
  // JUnit, xUnit and XCTest name a test class after what it tests: `ServerTest.java`, `ParserTests.cs`.
  /[a-z0-9]Tests?\.(java|kt|cs|scala|swift)$/,
]

// Rust's `mod tests`, and the `test_` prefix pytest collects.
const TEST_SCOPE = /(^|::|\.)tests?(::|\.)|(^|::|\.)test_/
// Go's `TestParse` and the `TestParser` classes unittest and pytest collect. Only code counts:
// a type such as `TestKind` is named like one and isn't a test.
const TEST_FRAMEWORK_NAME = /^Test(?:[A-Z0-9_]|$)/
const CODE_KINDS: ReadonlySet<UnitKind> = new Set([UnitKind.Function, UnitKind.Method, UnitKind.Class])

/** What `isTestUnit` needs of a unit, from a changed unit or a definition alike. */
export interface NamedUnit {
  readonly kind: UnitKind
  readonly qualifiedName: string
}

export function isTestPath(path: string): boolean {
  return TEST_PATHS.some((pattern) => pattern.test(path))
}

/** A test by its kind, from the framework's own calls, or by the names test frameworks collect. */
export function isTestUnit(unit: NamedUnit): boolean {
  return isTestKind(unit.kind) || TEST_SCOPE.test(unit.qualifiedName) || (CODE_KINDS.has(unit.kind) && TEST_FRAMEWORK_NAME.test(unit.qualifiedName))
}
