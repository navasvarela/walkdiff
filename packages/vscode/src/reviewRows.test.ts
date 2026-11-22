import { REVIEW_MODEL_SCHEMA_VERSION, reviewModelSchema, reviewSummarySchema } from "@walkdiff/review-model"
import type { ReviewModel, ReviewSummary, Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { changedFileRows, isAnalyzing, pullRequestFindings, reviewRow } from "./reviewRows.ts"

const SHA = "a".repeat(40)
const TEXT = { kind: "text", hunks: [] } as const

function summary(overrides: object = {}): ReviewSummary {
  return reviewSummarySchema.parse({
    id: 1,
    url: "https://github.com/acme/app/pull/7",
    host: "github",
    displayName: "acme/app#7",
    number: 7,
    status: "ready",
    error: null,
    hasReport: true,
    ai: false,
    title: "Cap retries",
    author: "dev",
    securityLevel: "low",
    unitsToReview: 3,
    untouchedReferences: 0,
    findings: 1,
    coverageSource: null,
    reportHead: null,
    stack: null,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
    ...overrides,
  })
}

function finding(path: string | null, severity: Risk["severity"], title = path ?? "whole"): Risk {
  return { ruleId: "r", category: "secret", severity, title, detail: "d", location: path === null ? null : { path, line: 3 }, evidence: null }
}

function report(findings: readonly Risk[]): ReviewModel {
  const file = (diff: object, noise: object | null = null): object => ({ diff: { additions: 2, deletions: 1, content: TEXT, ...diff }, noise, syntax: { status: "unsupportedLanguage" } })
  return reviewModelSchema.parse({
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: "2026-11-22T00:00:00.000Z",
    pullRequest: { host: "github", url: "https://github.com/acme/app/pull/7", repositoryWebUrl: "https://github.com/acme/app", number: 7, title: "t", description: "", author: "dev", baseRef: "main", headRef: "x", baseSha: SHA, headSha: SHA, mergeBaseSha: SHA },
    files: [
      file({ status: "modified", path: "pnpm-lock.yaml" }, { kind: "lockfile", reason: "r" }),
      file({ status: "renamed", path: "src/limits.ts", previousPath: "src/caps.ts", similarity: 90 }),
      file({ status: "modified", path: "src/retry.ts" }),
    ],
    risk: { securityLevel: "high", findings, checksRun: [], notChecked: [] },
    ai: { status: "disabled" },
    feedbackUrl: null,
  })
}

describe("reviewRow", () => {
  it.each([
    [{ status: "queued" }, "Waiting to start"],
    [{ status: "analyzing", step: null }, "Analyzing"],
    [{ status: "failed", error: "No such PR" }, "No such PR"],
    [{}, "3 to review · 1 finding"],
    [{ securityLevel: "high", findings: 2 }, "3 to review · 2 findings · high security"],
  ])("describes a review with %j as %s", (overrides, description) => {
    expect(reviewRow(summary(overrides)).description).toBe(description)
  })

  it("names the review and marks its status for the menus", () => {
    expect(reviewRow(summary({ status: "failed" }))).toMatchObject({ label: "acme/app#7 Cap retries", contextValue: "review.failed" })
  })
})

describe("isAnalyzing", () => {
  it("is true while any review is waiting or running", () => {
    expect(isAnalyzing([summary(), summary({ status: "queued" })])).toBe(true)
    expect(isAnalyzing([summary(), summary({ status: "failed" })])).toBe(false)
  })
})

describe("changedFileRows", () => {
  it("keeps the report's order with skippable files last, and gives each file its findings, worst first", () => {
    const rows = changedFileRows(report([finding("src/retry.ts", "low", "a"), finding("src/retry.ts", "high", "b")]))
    expect(rows.map((row) => [row.path, row.description])).toEqual([
      ["src/limits.ts", "+2 −1 · from src/caps.ts"],
      ["src/retry.ts", "+2 −1 · 2 findings"],
      ["pnpm-lock.yaml", "+2 −1 · lockfile"],
    ])
    expect(rows[0]?.basePath).toBe("src/caps.ts")
    expect(rows[1]?.findings.map((entry) => entry.title)).toEqual(["b", "a"])
  })
})

describe("pullRequestFindings", () => {
  it("collects what no changed file shows", () => {
    expect(pullRequestFindings(report([finding(null, "low"), finding("README.md", "medium"), finding("src/retry.ts", "high")])).map((entry) => entry.title)).toEqual(["README.md", "whole"])
  })
})
