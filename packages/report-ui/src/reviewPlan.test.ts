import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ModificationWeight, REVIEW_MODEL_SCHEMA_VERSION, reviewModelSchema, RiskCategory, RiskSeverity, SyntaxAnalysisStatus, UnitChangeKind, UnitImpactStatus, UnitKind } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, ReviewModel, Risk, UnitKind as UnitKindType } from "@walkdiff/review-model"
import { buildReviewPlan, GuideRouteKind, guideRouteFromHash } from "./reviewPlan.ts"

const SNAPSHOT = { startLine: 1, endLine: 5, text: "body", elidesNestedUnits: false }

interface UnitOptions {
  readonly name: string
  readonly kind?: UnitKindType
  readonly callers?: number
  readonly added?: boolean
  readonly quiet?: boolean
}

function unit({ name, kind = UnitKind.Function, callers = 0, added = false, quiet = false }: UnitOptions): ChangedUnit {
  const reference = { path: "other.ts", line: 1, callerQualifiedName: null, confidence: "likely", touchedByPullRequest: false, snippet: name } as const
  return {
    kind,
    name,
    qualifiedName: name,
    change: added
      ? { kind: UnitChangeKind.Added, after: SNAPSHOT }
      : { kind: UnitChangeKind.Modified, weight: quiet ? ModificationWeight.FormattingOnly : ModificationWeight.Semantic, before: SNAPSHOT, after: SNAPSHOT },
    facts: null,
    impact: callers === 0 ? null : { status: UnitImpactStatus.Traced, searchedName: name, references: Array.from({ length: callers }, () => reference), totalReferences: callers },
  }
}

function file(path: string, units: readonly ChangedUnit[] = []): ChangedFile {
  return {
    diff: { status: "modified", path, additions: 1, deletions: 0, content: { kind: "text", hunks: [] } },
    noise: null,
    syntax: units.length === 0 ? { status: SyntaxAnalysisStatus.UnsupportedLanguage } : { status: SyntaxAnalysisStatus.Analyzed, language: "typescript", units, outline: [], calls: [] },
  }
}

function finding(category: Risk["category"], severity: Risk["severity"], title: string, path: string | null, line: number | null = null): Risk {
  return { ruleId: title, category, severity, title, detail: "", location: path === null ? null : { path, line }, evidence: null }
}

function review(files: readonly ChangedFile[], findings: readonly Risk[] = []): ReviewModel {
  // Parsing keeps this fixture honest against the real contract, without a cast.
  return reviewModelSchema.parse({
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: "2026-10-31T00:00:00.000Z",
    pullRequest: { url: "https://github.com/o/r/pull/1", number: 1, title: "t", description: "", author: "a", baseRef: "main", headRef: "b", baseSha: "a".repeat(40), headSha: "b".repeat(40), mergeBaseSha: "c".repeat(40), repositoryWebUrl: "https://github.com/o/r", host: "github" },
    files,
    risk: { securityLevel: RiskSeverity.Low, findings, checksRun: [], notChecked: [] },
    ai: { status: "disabled" },
    feedbackUrl: null,
  })
}

const titles = (model: ReviewModel): readonly string[] => buildReviewPlan(model).stops.map((stop) => stop.title)

describe("buildReviewPlan", () => {
  it("keeps every flagged change on the path, past its usual limit", () => {
    const names = Array.from({ length: 20 }, (_, index) => `flagged${index}`)
    const model = review(names.map((name) => file(`${name}.ts`, [unit({ name })])), names.map((name) => finding(RiskCategory.DangerousApi, RiskSeverity.Medium, name, `${name}.ts`, 2)))
    const plan = buildReviewPlan(model)
    expect(plan.stops).toHaveLength(20)
    expect(plan.pastTheLimit).toBe(0)
    expect(plan.findingsOffPath).toBe(0)
  })

  it("keeps a flagged change that ranks below the limit, and counts unflagged ones left off", () => {
    const busy = Array.from({ length: 20 }, (_, index) => file(`busy${index}.ts`, [unit({ name: `busy${index}`, callers: 20 })]))
    const plan = buildReviewPlan(review([...busy, file("low.ts", [unit({ name: "low" })])], [finding(RiskCategory.Tests, RiskSeverity.Low, "low", "low.ts", 2)]))
    expect(plan.stops.map((stop) => stop.title)).toContain("low")
    expect(plan.stops).toHaveLength(16)
    expect(plan.pastTheLimit).toBe(5)
  })

  it("counts a finding the path can't reach, such as one in a test file", () => {
    const plan = buildReviewPlan(review([file("a.ts", [unit({ name: "a" })]), file("tests/a.test.ts")], [finding(RiskCategory.Secret, RiskSeverity.High, "key", "tests/a.test.ts", 1)]))
    expect(plan.findingsOffPath).toBe(1)
  })

  it("doesn't count a finding about the whole PR as one the path missed", () => {
    const plan = buildReviewPlan(review([file("a.ts", [unit({ name: "a" })])], [finding(RiskCategory.Tests, RiskSeverity.Medium, "No tests added or changed", null)]))
    expect(plan.findingsOffPath).toBe(0)
  })

  it("doesn't count size or code quality as findings the path missed", () => {
    const plan = buildReviewPlan(review([file("a.ts", [unit({ name: "a" })])], [finding(RiskCategory.Size, RiskSeverity.High, "big", null), finding(RiskCategory.CodeQuality, RiskSeverity.Low, "messy", "other.ts", 1)]))
    expect(plan.findingsOffPath).toBe(0)
  })

  it("puts a high finding ahead of everything else", () => {
    const model = review([file("a.ts", [unit({ name: "busy", callers: 20 })]), file("z.ts", [unit({ name: "flagged" })])], [finding(RiskCategory.DangerousApi, RiskSeverity.High, "eval", "z.ts", 2)])
    expect(titles(model).at(0)).toBe("flagged")
  })

  it("does not let many small findings outrank a function others depend on", () => {
    const deps = Array.from({ length: 7 }, (_, index) => finding(RiskCategory.Dependency, RiskSeverity.Low, `dep ${index}`, "package.json", 1))
    const model = review([file("package.json"), file("a.ts", [unit({ name: "busy", callers: 10 })])], deps)
    expect(titles(model)).toEqual(["busy", "package.json"])
  })

  it("ranks a function above a definition with the same number of users", () => {
    const model = review([file("a.ts", [unit({ name: "Kinds", kind: UnitKind.Enum, callers: 6 }), unit({ name: "run", callers: 6 })])])
    expect(titles(model).at(0)).toBe("run")
  })

  it("leaves out tests, formatting and top-level code with nothing wrong", () => {
    const model = review([file("src/a.test.ts", [unit({ name: "case_a" })]), file("b.ts", [unit({ name: "tidy", quiet: true }), unit({ name: "imports", kind: UnitKind.ModuleScope }), unit({ name: "real" })])])
    expect(titles(model)).toEqual(["real"])
  })

  it("stops at an edited move where it arrived, and leaves an unedited one off", () => {
    const moved = (name: string, edited: boolean): ChangedUnit => ({
      ...unit({ name }),
      change: { kind: UnitChangeKind.MovedIn, from: { path: "old.ts", qualifiedName: name }, edited, before: SNAPSHOT, after: SNAPSHOT },
    })
    const departed = (name: string): ChangedUnit => ({ ...unit({ name }), change: { kind: UnitChangeKind.MovedOut, to: { path: "new.ts", qualifiedName: name }, edited: true, before: SNAPSHOT } })
    const model = review([file("old.ts", [departed("edited")]), file("new.ts", [moved("edited", true), moved("unedited", false)])])
    expect(buildReviewPlan(model).stops.map((stop) => `${stop.file.diff.path} ${stop.title}`)).toEqual(["new.ts edited"])
  })

  it("explains each stop without repeating what is true of every stop", () => {
    const plan = buildReviewPlan(review([file("a.ts", [unit({ name: "run", callers: 2 })])]))
    expect(plan.stops.at(0)?.reasons).toEqual(["2 places this PR didn't change depend on it"])
  })

  it("still gives a start to a PR of only new code", () => {
    const model = review([file("a.ts", [unit({ name: "one", added: true }), unit({ name: "two", added: true }), unit({ name: "three", added: true }), unit({ name: "four", added: true })])])
    const plan = buildReviewPlan(model)
    expect(plan.stops).toHaveLength(3)
    expect(plan.lowerPriority.newCode).toBe(1)
  })

  it("caps the path and counts the rest as lower priority", () => {
    const units = Array.from({ length: 30 }, (_, index) => unit({ name: `f${index}`, callers: 5 }))
    const plan = buildReviewPlan(review([file("a.ts", units)]))
    expect(plan.stops).toHaveLength(15)
    expect(plan.lowerPriority.otherCode).toBe(15)
  })

  it("groups one decision into one check, keeps at most three, and leaves size out", () => {
    const deps = Array.from({ length: 7 }, (_, index) => finding(RiskCategory.Dependency, RiskSeverity.Low, `dep ${index}`, "package.json", 1))
    const others = ["a", "b", "c"].map((name) => finding(RiskCategory.SensitivePath, RiskSeverity.Medium, name, `${name}.ts`))
    const plan = buildReviewPlan(review([file("package.json")], [...deps, ...others, finding(RiskCategory.Size, RiskSeverity.High, "Large change", null)]))
    expect(plan.checks).toHaveLength(3)
    expect(plan.moreChecks).toBe(1)
    expect(plan.checks.every((check) => check.severity === RiskSeverity.Medium)).toBe(true)
    expect(plan.sizeNote).toBe("Large change")
  })

  it("links a check to its stop, and explains a whole-file finding in words", () => {
    const pipeline = { ...finding(RiskCategory.SensitivePath, RiskSeverity.Medium, "CI pipeline", "ci.yml"), detail: "Pipelines hold secrets. More text." }
    const plan = buildReviewPlan(review([file("ci.yml")], [pipeline]))
    expect(plan.checks.at(0)?.stopIndex).toBe(0)
    expect(plan.stops.at(0)?.reasons).toEqual(["CI pipeline: Pipelines hold secrets."])
  })

  it("shows code quality as a reason at a stop, not as a check, and below security findings", () => {
    const messy = finding(RiskCategory.CodeQuality, RiskSeverity.High, "Very long function", "messy.ts", 2)
    const risky = finding(RiskCategory.DangerousApi, RiskSeverity.Medium, "eval", "risky.ts", 2)
    const plan = buildReviewPlan(review([file("messy.ts", [unit({ name: "messy" })]), file("risky.ts", [unit({ name: "risky" })])], [messy, risky]))
    expect(plan.stops.at(0)?.title).toBe("risky")
    expect(plan.stops.find((stop) => stop.title === "messy")?.reasons).toContain("Flagged: Very long function")
    expect(plan.checks.map((check) => check.message)).toEqual([expect.stringContaining("eval")])
  })

  it("ranks untested changes higher and says so, using only lines inside the function", () => {
    const tested = unit({ name: "tested", callers: 2 })
    const untested = unit({ name: "untested", callers: 2 })
    const model = { ...review([file("a.ts", [tested]), file("b.ts", [untested])]), testCoverage: { source: "lcov.info", files: [{ path: "a.ts", coveredLines: [1, 2], uncoveredLines: [] }, { path: "b.ts", coveredLines: [], uncoveredLines: [1, 2, 99] }] } }
    const plan = buildReviewPlan(model)
    expect(plan.stops.at(0)?.title).toBe("untested")
    expect(plan.stops.at(0)?.reasons).toContain("None of its 2 changed lines ran in tests")
    expect(plan.stops.at(0)?.coverage).toEqual({ kind: "lines", coveredLines: [], uncoveredLines: [1, 2] })
    expect(plan.stops.at(1)?.reasons.join()).not.toContain("ran in tests")
  })

  it("says how many lines ran when only some did", () => {
    const model = { ...review([file("a.ts", [unit({ name: "partly" })])]), testCoverage: { source: "x", files: [{ path: "a.ts", coveredLines: [1, 2], uncoveredLines: [3] }] } }
    expect(buildReviewPlan(model).stops.at(0)?.reasons).toContain("1 of its 3 changed lines didn't run in tests")
  })

  it("keeps new code that no test ran on the path, even with nothing else to say about it", () => {
    const busy = Array.from({ length: 3 }, (_, index) => file(`busy${index}.ts`, [unit({ name: `busy${index}`, callers: 4 })]))
    const lonely = file("totals.ts", [unit({ name: "totalSize", added: true })])
    const unloaded = file("duplicates.ts", [unit({ name: "findDuplicates", added: true })])
    const model = {
      ...review([...busy, lonely, unloaded]),
      testCoverage: { source: "lcov.info", files: [...busy.map((entry) => ({ path: entry.diff.path, coveredLines: [1, 2], uncoveredLines: [] })), { path: "totals.ts", coveredLines: [], uncoveredLines: [1, 2, 3] }] },
    }
    expect(titles(model)).toEqual(expect.arrayContaining(["totalSize", "findDuplicates"]))
  })

  it("counts a function no test called as untested, though its declaration line ran", () => {
    const busy = Array.from({ length: 3 }, (_, index) => file(`busy${index}.ts`, [unit({ name: `busy${index}`, callers: 4 })]))
    const uncalled = { ...unit({ name: "totalSize", added: true }), change: { kind: UnitChangeKind.Added, after: { ...SNAPSHOT, startLine: 1, endLine: 10 } } }
    const model = {
      ...review([...busy, file("sizes.ts", [uncalled])]),
      testCoverage: { source: "lcov.info", files: [...busy.map((entry) => ({ path: entry.diff.path, coveredLines: [1, 2], uncoveredLines: [] })), { path: "sizes.ts", coveredLines: [1], uncoveredLines: [2, 3, 4, 5, 6, 7, 8, 9, 10] }] },
    }
    const stop = buildReviewPlan(model).stops.find((candidate) => candidate.title === "totalSize")
    expect(stop?.reasons).toContain("9 of its 10 changed lines didn't run in tests")
  })

  it("has no coverage for a function the report says nothing about", () => {
    const model = { ...review([file("a.ts", [unit({ name: "other", callers: 2 })])]), testCoverage: { source: "x", files: [{ path: "a.ts", coveredLines: [50], uncoveredLines: [] }] } }
    expect(buildReviewPlan(model).stops.at(0)?.coverage).toBeNull()
  })

  describe("a changed file the coverage report leaves out", () => {
    const reportFor = (files: readonly ChangedFile[]): ReviewModel => ({ ...review(files), testCoverage: { source: "lcov.info", files: [{ path: "lib/sizes.js", coveredLines: [1], uncoveredLines: [] }] } })

    it("says no test may have loaded it, and ranks it above code that ran", () => {
      const plan = buildReviewPlan(reportFor([file("lib/sizes.js", [unit({ name: "formatSize" })]), file("lib/duplicates.js", [unit({ name: "findDuplicates" })])]))
      const stop = plan.stops.find((candidate) => candidate.title === "findDuplicates")
      expect(plan.stops.at(0)).toBe(stop)
      expect(stop?.coverage).toEqual({ kind: "fileNotInReport" })
      expect(stop?.reasons).toContain("Its file isn't in the coverage report, so no test may have loaded it")
    })

    it.each([
      { name: "a test file", path: "test/duplicates.test.js" },
      { name: "a file in another language", path: "scripts/dedupe.py" },
      { name: "a file without an extension", path: "bin/dedupe" },
    ])("says nothing about $name", ({ path }) => {
      const plan = buildReviewPlan(reportFor([file("lib/sizes.js", [unit({ name: "formatSize" })]), file(path, [unit({ name: "dedupe" })])]))
      expect(plan.stops.find((stop) => stop.title === "dedupe")?.coverage ?? null).toBeNull()
    })
  })

  it("finds tests by the code they mention, in other files or the same one", () => {
    const test: ChangedFile = {
      ...file("tests/run.spec.ts"),
      diff: { status: "modified", path: "tests/run.spec.ts", additions: 1, deletions: 0, content: { kind: "text", hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, section: "", lines: [{ kind: "added", content: "parse_input()", newLine: 1 }] }] } },
    }
    const plan = buildReviewPlan(review([test, file("a.ts", [unit({ name: "parse_input", callers: 5 }), unit({ name: "untested", callers: 5 })])]))
    expect(plan.stops.find((stop) => stop.title === "parse_input")?.relatedTests).toEqual(["tests/run.spec.ts"])
    expect(plan.stops.find((stop) => stop.title === "untested")?.relatedTests).toEqual([])
  })
})

describe("breaking changes on the path", () => {
  const removed: ChangedUnit = { kind: UnitKind.Function, name: "parse", qualifiedName: "parse", change: { kind: UnitChangeKind.Removed, before: SNAPSHOT }, facts: null, impact: null }
  const renamed: ChangedUnit = { kind: UnitKind.Function, name: "decode", qualifiedName: "decode", change: { kind: UnitChangeKind.Renamed, previousName: "parse", before: SNAPSHOT, after: SNAPSHOT }, facts: null, impact: null }
  const breaking = (title: string, path: string, line: number | null, unitName: string | undefined): Risk => ({
    ...finding(RiskCategory.BreakingChange, RiskSeverity.Medium, title, path, line),
    detail: "Code outside this repository may break. Keep an alias.",
    unit: unitName,
  })

  it("gives a removed unit its finding, though it has no line at head, and says what could break", () => {
    const plan = buildReviewPlan(review([file("a.ts", [removed])], [breaking("Public function parse was removed", "a.ts", null, "parse")]))
    expect(plan.stops.at(0)?.findings.map((item) => item.title)).toEqual(["Public function parse was removed"])
    expect(plan.stops.at(0)?.reasons).toEqual(["Public function parse was removed: Code outside this repository may break."])
    expect(plan.checks.at(0)).toMatchObject({ stopIndex: 0, message: "Public function parse was removed in a.ts. This may break callers or a deployment, so check who depends on it." })
  })

  it("keeps a rename off the path unless it could break someone", () => {
    expect(titles(review([file("a.ts", [renamed])]))).toEqual([])
    expect(titles(review([file("a.ts", [renamed])], [breaking("Public function parse was renamed to decode", "a.ts", 1, "decode")]))).toEqual(["decode"])
  })

  it("says what could break on a change with a line too", () => {
    const plan = buildReviewPlan(review([file("a.ts", [unit({ name: "parse" })])], [breaking("parse no longer takes a", "a.ts", 1, "parse")]))
    expect(plan.stops.at(0)?.reasons.at(0)).toBe("parse no longer takes a: Code outside this repository may break.")
  })

  it("stops on a migration or config file with no functions in it", () => {
    const plan = buildReviewPlan(review([file("migrations/1.sql")], [breaking("Migration drops table users", "migrations/1.sql", 1, undefined)]))
    expect(plan.stops.map((stop) => stop.title)).toEqual(["migrations/1.sql"])
    expect(plan.checks.at(0)?.stopIndex).toBe(0)
  })

  it("ranks above an ordinary medium finding and below any high one", () => {
    const model = review(
      [file("a.ts", [unit({ name: "ordinary" })]), file("b.ts", [unit({ name: "breaks" })]), file("c.ts", [unit({ name: "dangerous" })])],
      [finding(RiskCategory.DangerousApi, RiskSeverity.Medium, "exec", "a.ts", 1), breaking("breaks no longer takes a", "b.ts", 1, "breaks"), finding(RiskCategory.DangerousApi, RiskSeverity.High, "eval", "c.ts", 1)],
    )
    expect(titles(model)).toEqual(["dangerous", "breaks", "ordinary"])
  })
})

describe("guideRouteFromHash", () => {
  it.each([
    ["", { kind: GuideRouteKind.Brief }],
    ["#review", { kind: GuideRouteKind.Brief }],
    ["#review/3", { kind: GuideRouteKind.Stop, index: 3 }],
    ["#review/finish", { kind: GuideRouteKind.Finish }],
    ["#changes", undefined],
    ["#risks", undefined],
  ])("reads %j", (hash, route) => {
    expect(guideRouteFromHash(hash)).toEqual(route)
  })
})

describe("the stylesheet", () => {
  // An unbalanced brace leaves no build error: every later rule silently nests inside the open one.
  it("closes every rule", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8")
    expect(css.split("{").length).toBe(css.split("}").length)
  })
})
