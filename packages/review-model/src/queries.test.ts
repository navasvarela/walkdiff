import { describe, expect, it } from "vitest"
import { codeSpan, isBehaviourChange, namesOfChecks, securitySummary } from "./queries.ts"
import { unitChangeSchema } from "./schema.ts"
import type { Risk, UnitChange } from "./schema.ts"

const named = (...names: readonly string[]) => names.map((name) => ({ name, detail: "" }))

describe("namesOfChecks", () => {
  it.each([
    [named(), ""],
    [named("Semgrep"), "Semgrep"],
    [named("Semgrep", "gitleaks"), "Semgrep and gitleaks"],
    [named("Built-in rules", "Semgrep", "gitleaks"), "Built-in rules, Semgrep and gitleaks"],
  ])("reads %j as a sentence", (checks, expected) => {
    expect(namesOfChecks(checks)).toBe(expected)
  })
})

describe("securitySummary", () => {
  const finding = (category: Risk["category"]): Risk => ({ ruleId: "r", category, severity: "low", title: "t", detail: "d", location: null, evidence: null })

  it.each<readonly [readonly Risk[], string]>([
    [[], "No security findings"],
    [[finding("codeQuality"), finding("size"), finding("breakingChange")], "No security findings"],
    [[finding("secret")], "1 security finding"],
    [[finding("secret"), finding("codeScan"), finding("codeQuality")], "2 security findings"],
  ])("counts only security findings: %j", (findings, expected) => {
    expect(securitySummary(findings)).toBe(expected)
  })
})

describe("codeSpan", () => {
  it("marks text as code, and a name can't end the span early", () => {
    expect(codeSpan("parse")).toBe("`parse`")
    expect(codeSpan("a`b\nc")).toBe("`abc`")
  })
})

describe("isBehaviourChange for moves", () => {
  const snapshot = { startLine: 1, endLine: 3, text: "fn f() {}", elidesNestedUnits: false }
  const location = { path: "other.rs", qualifiedName: "f" }
  const movedIn = (edited: boolean): UnitChange => ({ kind: "movedIn", from: location, edited, before: snapshot, after: snapshot })
  const movedOut = (edited: boolean): UnitChange => ({ kind: "movedOut", to: location, edited, before: snapshot })

  it.each([
    { name: "an unedited arrival", change: movedIn(false), expected: false },
    { name: "an edited arrival", change: movedIn(true), expected: true },
    // The edit is read where the unit arrived; counting the side it left too would count it twice.
    { name: "an edited departure", change: movedOut(true), expected: false },
  ])("is $expected for $name", ({ change, expected }) => {
    expect(isBehaviourChange(change)).toBe(expected)
  })

  it("reads a move from an older report, which has no edited flag, as unedited", () => {
    const parsed = unitChangeSchema.parse({ kind: "movedIn", from: location, before: snapshot, after: snapshot })
    expect(parsed).toMatchObject({ edited: false })
    expect(isBehaviourChange(parsed)).toBe(false)
  })
})
