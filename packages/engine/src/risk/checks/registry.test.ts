import { describe, expect, it } from "vitest"
import { BUILT_IN_RULES_CHECK } from "./builtInRules.ts"
import { CHECKS, STEP_ORDER } from "./registry.ts"

describe("the check registry", () => {
  it("puts every check on a step the progress display shows", () => {
    expect(CHECKS.every((check) => STEP_ORDER.includes(check.step))).toBe(true)
  })

  it("lists each check once", () => {
    expect(new Set(CHECKS).size).toBe(CHECKS.length)
  })

  // repeatedFindings.ts keeps the first finding on a line, which must be the built-in rules'.
  it("reports the built-in rules first", () => {
    expect(CHECKS[0]).toBe(BUILT_IN_RULES_CHECK)
  })
})
