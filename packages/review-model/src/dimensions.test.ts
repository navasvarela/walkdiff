import { describe, expect, it } from "vitest"
import { BUILT_IN_DIMENSIONS, dimensionOf } from "./dimensions.ts"
import { securitySummary } from "./queries.ts"
import { DimensionKind, RiskCategory } from "./schema.ts"
import type { Dimension, Risk } from "./schema.ts"

const DOCS_DRIFT: Dimension = { id: "docsDrift", label: "Docs drift", kind: DimensionKind.Review, advice: "Update the docs that describe it." }

function finding(category: string): Risk {
  return { ruleId: `${category}.rule`, category, severity: "medium", title: "t", detail: "d", location: null, evidence: null }
}

describe("dimensions", () => {
  it("describes every built-in category once", () => {
    const ids = BUILT_IN_DIMENSIONS.map((entry) => entry.id)
    expect(new Set(ids)).toEqual(new Set(Object.values(RiskCategory)))
    expect(ids).toHaveLength(Object.values(RiskCategory).length)
  })

  it("reads a category from the report first, then the built-in table, then names it after itself", () => {
    expect(dimensionOf("docsDrift", [DOCS_DRIFT])).toBe(DOCS_DRIFT)
    expect(dimensionOf(RiskCategory.SupplyChain, undefined).label).toBe("Supply chain")
    expect(dimensionOf("fromTheFuture", undefined)).toEqual({ id: "fromTheFuture", label: "fromTheFuture", kind: DimensionKind.Review, advice: "Check whether it applies here." })
  })

  it("lets a report's dimension describe a built-in category differently", () => {
    const stricter: Dimension = { ...DOCS_DRIFT, id: RiskCategory.License, kind: DimensionKind.Security }
    expect(dimensionOf(RiskCategory.License, [stricter]).kind).toBe(DimensionKind.Security)
  })

  it("counts a finding as security when its dimension says so, built in or not", () => {
    const leak: Dimension = { id: "dataLeak", label: "Data leak", kind: DimensionKind.Security, advice: "Check what it logs." }
    const findings = [finding("dataLeak"), finding("docsDrift"), finding(RiskCategory.Secret), finding(RiskCategory.BreakingChange)]
    expect(securitySummary({ findings, dimensions: [leak, DOCS_DRIFT] })).toBe("2 security findings")
    // Reports from before dimensions were recorded only use built-in categories.
    expect(securitySummary({ findings: [finding(RiskCategory.Secret), finding(RiskCategory.Tests)] })).toBe("1 security finding")
  })
})
