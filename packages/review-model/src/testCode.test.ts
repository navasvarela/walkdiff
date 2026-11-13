import { describe, expect, it } from "vitest"
import { UnitKind } from "./schema.ts"
import { isTestPath, isTestUnit } from "./testCode.ts"

describe("isTestPath", () => {
  it.each([
    ["src/parser.test.ts", true],
    ["src/parser.spec.tsx", true],
    ["src/__tests__/parser.ts", true],
    ["tests/test_parser.py", true],
    ["app/test_models.py", true],
    ["src/parser_test.rs", true],
    ["src/tests.rs", true],
    ["server/handler_test.go", true],
    ["src/store_test.c", true],
    ["src/server_test.cc", true],
    ["spec/models/user_spec.rb", true],
    ["src/test/java/ServerTest.java", true],
    ["app/src/androidTest/ParserTests.kt", true],
    ["Sources/ParserTests.swift", true],
    ["Tests/AppTests/Routes.swift", true],
    ["internal/testing/fixtures.go", true],
    ["src/main/java/Server.java", false],
    ["src/latest.go", false],
    ["src/contest.cc", false],
    ["src/main/java/Contest.java", false],
    ["docs/testimonials.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected)
  })
})

describe("isTestUnit", () => {
  it.each([
    [UnitKind.Test, "parser › reads", true],
    [UnitKind.TestSuite, "parser", true],
    [UnitKind.Function, "tests::parses_numbers", true],
    [UnitKind.Function, "test_parses_numbers", true],
    [UnitKind.Method, "ParserTest.test_reads", true],
    [UnitKind.Function, "TestParse", true],
    [UnitKind.Class, "TestParser", true],
    [UnitKind.Method, "TestParser.setUp", true],
    [UnitKind.TypeAlias, "TestKind", false],
    [UnitKind.Function, "Testify", false],
    [UnitKind.Function, "latest", false],
    [UnitKind.Function, "parse", false],
  ])("%s %s → %s", (kind, qualifiedName, expected) => {
    expect(isTestUnit({ kind, qualifiedName })).toBe(expected)
  })
})
