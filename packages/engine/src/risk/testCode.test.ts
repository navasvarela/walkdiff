import { describe, expect, it } from "vitest"
import { isTestPath } from "./testCode.ts"

describe("isTestPath", () => {
  it.each([
    ["src/parser.test.ts", true],
    ["tests/test_parser.py", true],
    ["src/parser_test.rs", true],
    ["server/handler_test.go", true],
    ["src/store_test.c", true],
    ["src/server_test.cc", true],
    ["src/main/java/Server.java", false],
    ["src/test/java/ServerTest.java", true],
    ["src/latest.go", false],
    ["src/contest.cc", false],
  ])("%s → %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected)
  })
})
