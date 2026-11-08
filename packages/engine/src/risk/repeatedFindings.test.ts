import type { Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { withoutRepeatedFindings } from "./repeatedFindings.ts"

const finding = (ruleId: string, category: Risk["category"], line: number | null, path = "app.py"): Risk => ({
  ruleId,
  category,
  severity: "medium",
  title: ruleId,
  detail: "",
  location: { path, line },
  evidence: null,
})

const ids = (findings: readonly Risk[]): string[] => withoutRepeatedFindings(findings).map((kept) => kept.ruleId)

describe("withoutRepeatedFindings", () => {
  it("drops Ruff's security finding where a built-in rule or Semgrep flagged the same line", () => {
    expect(ids([finding("python.subprocess-shell", "dangerousApi", 4), finding("ruff-security.S602", "codeScan", 4)])).toEqual(["python.subprocess-shell"])
    expect(ids([finding("semgrep.python.yaml-load", "codeScan", 5), finding("ruff-security.S506", "codeScan", 5)])).toEqual(["semgrep.python.yaml-load"])
  })

  it("keeps Ruff's finding on a line nothing else flagged, or flagged only for quality", () => {
    expect(ids([finding("python.subprocess-shell", "dangerousApi", 4), finding("ruff-security.S324", "codeScan", 7), finding("ruff-security.S324", "codeScan", 4, "other.py")])).toEqual([
      "python.subprocess-shell",
      "ruff-security.S324",
      "ruff-security.S324",
    ])
    expect(ids([finding("ruff.F401", "codeQuality", 3), finding("ruff-security.S301", "codeScan", 3)])).toEqual(["ruff.F401", "ruff-security.S301"])
  })

  it("keeps the first of several secrets on one line, including file-level ones", () => {
    expect(ids([finding("secret.aws", "secret", 2), finding("gitleaks.aws", "secret", 2), finding("secret.key-file", "secret", null), finding("semgrep.key-file", "secret", null)])).toEqual(["secret.aws", "secret.key-file"])
  })
})
