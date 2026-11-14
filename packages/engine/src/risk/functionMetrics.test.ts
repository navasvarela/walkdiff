import { UnitKind } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import type { FunctionQuality } from "../syntax/functionQuality.ts"
import { scanFunctionMetrics } from "./functionMetrics.ts"

const SMALL = { complexity: 2, nesting: 1, lines: 10, parameters: 1 }

function measured(before: FunctionQuality["before"], after: FunctionQuality["after"], path = "src/a.ts", qualifiedName = "parse"): FunctionQuality {
  return { path, kind: UnitKind.Function, qualifiedName, line: 7, before, after }
}

describe("scanFunctionMetrics", () => {
  it.each([
    ["new over the limit", undefined, 16, true],
    ["new at the limit", undefined, 15, false],
    ["crossing the limit", 15, 16, true],
    ["unchanged over the limit", 40, 40, false],
    ["slightly worse when already over", 40, 41, false],
    ["meaningfully worse when already over", 40, 48, true],
    ["improved but still over", 40, 30, false],
  ] as const)("complexity: %s", (_name, before, after, flagged) => {
    const findings = scanFunctionMetrics([measured(before === undefined ? undefined : { ...SMALL, complexity: before }, { ...SMALL, complexity: after })])
    expect(findings.length > 0).toBe(flagged)
  })

  it("says what changed, in a category that is not a security one", () => {
    const [finding] = scanFunctionMetrics([measured({ ...SMALL, complexity: 8 }, { ...SMALL, complexity: 23 })])
    expect(finding).toMatchObject({
      ruleId: "quality.complexity",
      category: "codeQuality",
      title: "Complex function",
      location: { path: "src/a.ts", line: 7 },
      evidence: "parse: complexity 8 → 23",
    })
  })

  it("flags each metric on its own", () => {
    const findings = scanFunctionMetrics([measured(undefined, { complexity: 16, nesting: 5, lines: 81, parameters: 7 })])
    expect(findings.map((finding) => finding.ruleId)).toEqual(["quality.complexity", "quality.nesting", "quality.lines", "quality.parameters"])
  })

  it.each([
    ["src/a.test.ts", "parse"],
    ["src/a.rs", "tests::parse"],
  ])("leaves test code out: %s %s", (path, name) => {
    expect(scanFunctionMetrics([measured(undefined, { ...SMALL, lines: 500 }, path, name)])).toEqual([])
  })
})
