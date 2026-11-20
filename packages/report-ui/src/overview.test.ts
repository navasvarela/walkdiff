import { DimensionKind, RiskCategory } from "@walkdiff/review-model"
import type { Dimension, Risk, RiskAssessment, RiskSeverity } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { dimensionSections, kindSummary, overviewHash, overviewSectionFromHash } from "./overview.ts"
import { ReportTab, tabFromHash } from "./tabs.ts"

function finding(category: string, severity: RiskSeverity, title = category): Risk {
  return { ruleId: `${category}.rule`, category, severity, title, detail: "d", location: null, evidence: null }
}

function assessment(findings: readonly Risk[], dimensions?: readonly Dimension[]): RiskAssessment {
  return { securityLevel: "low", findings: [...findings], checksRun: [], notChecked: [], ...(dimensions === undefined ? {} : { dimensions }) }
}

const DOCS_DRIFT: Dimension = { id: "docsDrift", label: "Docs drift", kind: DimensionKind.Review, advice: "Update the docs to match." }

describe("dimensionSections", () => {
  it("puts security first, then decisions, then background, each by worst finding and then the built-in order, with the report's own dimensions last", () => {
    const findings = [
      finding(RiskCategory.CodeQuality, "low"),
      finding("docsDrift", "medium"),
      finding(RiskCategory.BreakingChange, "medium"),
      finding(RiskCategory.SupplyChain, "medium"),
      finding(RiskCategory.Secret, "high"),
      finding(RiskCategory.AttackSurface, "low"),
      finding(RiskCategory.DangerousApi, "high"),
    ]
    expect(dimensionSections(assessment(findings, [DOCS_DRIFT])).map((section) => section.dimension.label)).toEqual(["Possible secret", "Risky API", "Supply chain", "Attack surface", "Breaking change", "Docs drift", "Code quality"])
  })

  it("keeps each dimension's findings in their order, and names the worst", () => {
    const [section] = dimensionSections(assessment([finding(RiskCategory.SupplyChain, "high", "a"), finding(RiskCategory.SupplyChain, "low", "b")]))
    expect(section?.findings.map((entry) => entry.title)).toEqual(["a", "b"])
    expect(section?.worst).toBe("high")
  })

  it("gives a category neither the report nor Walkdiff knows a section of its own", () => {
    expect(dimensionSections(assessment([finding("fromTheFuture", "low")])).map((section) => section.dimension.label)).toEqual(["fromTheFuture"])
  })
})

describe("kindSummary", () => {
  it("counts what isn't security, which the summary above it already counts", () => {
    const sections = dimensionSections(assessment([finding(RiskCategory.Secret, "high"), finding(RiskCategory.BreakingChange, "medium"), finding(RiskCategory.CodeQuality, "low"), finding(RiskCategory.Size, "low")]))
    expect(kindSummary(sections)).toBe("Also 1 needs a decision · 2 for background")
    expect(kindSummary(dimensionSections(assessment([finding(RiskCategory.Secret, "high")])))).toBe("")
  })
})

describe("overview links", () => {
  it.each(["supplyChain", "checks", "a/b c"])("links to %s and reads it back, on the Risks tab", (section) => {
    const hash = overviewHash(section)
    expect(overviewSectionFromHash(hash)).toBe(section)
    expect(tabFromHash(hash)).toBe(ReportTab.Risks)
  })

  it("names no section for the tab itself or another tab", () => {
    expect(overviewSectionFromHash("#risks")).toBeUndefined()
    expect(overviewSectionFromHash("#risks/")).toBeUndefined()
    expect(overviewSectionFromHash("#impact/x")).toBeUndefined()
    expect(tabFromHash("#impact/x")).toBe(ReportTab.Impact)
  })
})
