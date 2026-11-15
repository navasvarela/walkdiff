import { describe, expect, it } from "vitest"
import type { Risk, RiskAssessment } from "./schema.ts"
import { summarizeChecks, totalsOf } from "./checkSummary.ts"

function finding(ruleId: string, category: Risk["category"] = "codeScan"): Risk {
  return { ruleId, category, severity: "medium", title: ruleId, detail: "d", location: null, evidence: null }
}

function assessment(findings: readonly Risk[], names: readonly string[], notChecked: RiskAssessment["notChecked"] = []): RiskAssessment {
  return { securityLevel: "low", findings: [...findings], checksRun: names.map((name) => ({ name, detail: `${name} detail` })), notChecked }
}

describe("summarizeChecks", () => {
  it.each([
    ["semgrep.python.x", "codeScan", "Semgrep"],
    ["gitleaks.aws", "secret", "gitleaks"],
    ["oxlint.eslint.no-var", "codeQuality", "oxlint"],
    ["ruff.E1", "codeQuality", "Ruff"],
    ["jscpd.duplicate", "codeQuality", "jscpd"],
    ["quality.complexity", "codeQuality", "Function metrics"],
    ["breaking.api-removed", "breakingChange", "Breaking changes"],
    ["GHSA-1", "vulnerability", "OSV database"],
    ["dependency.added", "dependency", "Built-in rules"],
    ["size.large", "size", "Built-in rules"],
    ["endpoint.added", "attackSurface", "Built-in rules"],
    ["errors.swallowed", "codeQuality", "Error handling"],
    ["supply-chain.integrity-changed", "supplyChain", "Supply chain"],
    ["supply-chain.provenance-dropped", "supplyChain", "npm release history"],
    ["supply-chain.new-publisher", "supplyChain", "npm release history"],
  ] as const)("credits %s to the check that found it", (ruleId, category, check) => {
    const names = ["Built-in rules", "Breaking changes", "Semgrep", "gitleaks", "Function metrics", "oxlint", "Ruff", "jscpd", "OSV database", "Error handling", "Supply chain", "npm release history"]
    expect(summarizeChecks(assessment([finding(ruleId, category)], names)).at(0)).toMatchObject({ outcome: "issues", name: check, issues: 1 })
  })

  it("credits a vulnerability to osv-scanner when that's the OSV check that ran", () => {
    expect(summarizeChecks(assessment([finding("GHSA-1", "vulnerability")], ["osv-scanner"])).at(0)).toMatchObject({ name: "osv-scanner", issues: 1 })
  })

  it("never loses a finding, even from a check not listed as run", () => {
    const rows = summarizeChecks(assessment([finding("semgrep.x"), finding("custom.y")], ["Built-in rules"]))
    expect(rows).toEqual([{ outcome: "issues", name: "Built-in rules", detail: "Built-in rules detail", issues: 2 }])
  })

  it("puts issues first, then what didn't run, then what was clean", () => {
    const rows = summarizeChecks(assessment([finding("semgrep.x")], ["Built-in rules", "Semgrep"], [{ check: "gitleaks secret scan", reason: "not installed" }]))
    expect(rows.map((row) => [row.name, row.outcome])).toEqual([["Semgrep", "issues"], ["gitleaks secret scan", "notRun"], ["Built-in rules", "clean"]])
    expect(totalsOf(rows)).toEqual({ clean: 1, withIssues: 1, notRun: 1 })
  })
})
