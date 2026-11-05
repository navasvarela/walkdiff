import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha, FileDiff } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runGit } from "../../git.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { oxlintArgs, parseOxlintOutput } from "./oxlint.ts"
import { parseJscpdReport } from "./jscpd.ts"
import { parseRuffOutput, ruffArgs } from "./ruff.ts"
import { runQualityScanners } from "./runQualityScanners.ts"
import type { ProcessResult, ScannerProcessRunner } from "./scannerProcess.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

function changed(path: string, content: string, addedLineNumbers: readonly number[]): ScannedFile {
  const lines = content.split("\n")
  const diff: FileDiff = {
    status: "modified",
    path,
    additions: addedLineNumbers.length,
    deletions: 0,
    content: {
      kind: "text",
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.length, section: "", lines: addedLineNumbers.map((line) => ({ kind: "added", content: lines.at(line - 1) ?? "", newLine: line })) }],
    },
  }
  return { diff, noise: null, after: content }
}

const OK = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: "" })
const NUMBERED = Array.from({ length: 30 }, (_, index) => `line${index + 1}`).join("\n")

interface Outcomes {
  readonly ruff?: (root: string) => ProcessResult | undefined
  readonly oxlint?: (root: string) => ProcessResult | undefined
  readonly jscpd?: (args: readonly string[]) => Promise<ProcessResult | undefined>
}

function fakeScanners(outcomes: Outcomes): { readonly run: ScannerProcessRunner; readonly seen: Map<string, readonly string[]> } {
  const seen = new Map<string, readonly string[]>()
  const run: ScannerProcessRunner = async (binary, args, cwd) => {
    seen.set(binary, (await readdir(cwd, { recursive: true })).map(String))
    if (binary === "ruff") return outcomes.ruff?.(cwd)
    if (binary === "oxlint") return outcomes.oxlint?.(cwd)
    return outcomes.jscpd?.(args)
  }
  return { run, seen }
}

const jscpdReporting = (duplicates: readonly object[]) => async (args: readonly string[]): Promise<ProcessResult> => {
  const outputDir = args.at(args.indexOf("--output") + 1) ?? ""
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, "jscpd-report.json"), JSON.stringify({ duplicates }))
  return OK("")
}

const clone = (firstPath: string, firstStart: number, firstEnd: number, secondPath: string, secondStart: number, secondEnd: number): object => ({
  firstFile: { name: firstPath, start: firstStart, end: firstEnd },
  secondFile: { name: secondPath, start: secondStart, end: secondEnd },
})

// What `db-migrate create` writes: every migration starts from this, so each repeats the last.
const DB_MIGRATE_MIGRATION = `'use strict';

var dbm;
var type;
var seed;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

exports.up = function(db) {
  return null;
};

exports.down = function(db) {
  return null;
};

exports._meta = {
  "version": 1
};
`

describe("runQualityScanners", () => {
  let repoDir = ""
  let head: CommitSha

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-quality-test-"))
    const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
    await git("init", "--quiet")
    for (const [path, content] of [["src/app.py", NUMBERED], ["src/ui.ts", NUMBERED], ["src/old.ts", NUMBERED], ["src/old.test.ts", NUMBERED], ["ruff.toml", "x"], [".jscpd.json", "{}"], ["src/.oxlintrc.ts", "x"], ["migrations/20261101000000-add-users.js", DB_MIGRATE_MIGRATION], ["migrations/20261102000000-add-orders.js", DB_MIGRATE_MIGRATION]] as const) {
      await mkdir(dirname(join(repoDir, path)), { recursive: true })
      await writeFile(join(repoDir, path), content)
    }
    await git("add", "--all")
    await git("commit", "--quiet", "--message", "head")
    head = commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  })
  afterAll(() => rm(repoDir, { recursive: true, force: true }))

  const scan = (files: readonly ScannedFile[], run: ScannerProcessRunner, isIgnored: (path: string) => boolean = () => false) => runQualityScanners({ repoDir, head, files, isIgnored, run })

  it("keeps linter findings on added lines, in the code quality category", async () => {
    const ruff = (root: string): ProcessResult =>
      OK(JSON.stringify([1, 2].map((row) => ({ code: "F401", name: "unused-import", filename: join(root, "src/app.py"), location: { row }, end_location: { row } }))))
    const { findings, checksRun, notChecked } = await scan([changed("src/app.py", NUMBERED, [2])], fakeScanners({ ruff, jscpd: jscpdReporting([]) }).run)
    expect(findings.map((finding) => [finding.ruleId, finding.category, finding.location?.path, finding.location?.line, finding.evidence])).toEqual([["ruff.F401", "codeQuality", "src/app.py", 2, "line2"]])
    expect(checksRun.map((check) => check.name)).toEqual(["Ruff", "jscpd"])
    expect(notChecked).toEqual([])
  })

  it("only lists a linter when the PR has files for it", async () => {
    const { notChecked } = await scan([changed("src/ui.ts", NUMBERED, [2])], fakeScanners({}).run)
    expect(notChecked.map((skipped) => skipped.check)).toEqual(["oxlint TypeScript lint", "jscpd duplicate detection"])
    expect(notChecked.at(0)?.reason).toContain("pnpm install")
  })

  it("does not copy config files a PR could use to change the results", async () => {
    const files = [changed("src/app.py", NUMBERED, [1]), changed("src/ui.ts", NUMBERED, [1]), changed("ruff.toml", "x", [1]), changed(".oxlintrc.json", "{}", [1]), changed("oxlint.config.ts", "x", [1]), changed("package.json", "{}", [1])]
    const { run, seen } = fakeScanners({ ruff: () => OK("[]"), oxlint: () => OK('{"diagnostics":[]}'), jscpd: jscpdReporting([]) })
    await scan(files, run)
    expect(seen.get("ruff")?.filter((name) => name.includes("."))).toEqual(["src/app.py"])
    expect(seen.get("oxlint")?.filter((name) => name.includes("."))).toEqual(["src/ui.ts"])
    expect(seen.get("jscpd")).not.toContain(".jscpd.json")
    expect(seen.get("jscpd")).not.toContain("ruff.toml")
    expect(seen.get("jscpd")).not.toContain("src/.oxlintrc.ts")
  })

  it("scans the whole repository for duplicates, leaving out tests and ignored paths", async () => {
    const { run, seen } = fakeScanners({ jscpd: jscpdReporting([]) })
    await scan([changed("src/ui.ts", NUMBERED, [1])], run, (path) => path === "src/app.py")
    const copied = seen.get("jscpd") ?? []
    expect(copied).toContain("src/old.ts")
    expect(copied).not.toContain("src/old.test.ts")
    expect(copied).not.toContain("src/app.py")
  })

  it("leaves database migrations out of duplicate detection, as they repeat a template by design", async () => {
    const { run, seen } = fakeScanners({ jscpd: jscpdReporting([]) })
    await scan([changed("src/ui.ts", NUMBERED, [1]), changed("migrations/20261102000000-add-orders.js", DB_MIGRATE_MIGRATION, [1, 2, 3])], run)
    const copied = seen.get("jscpd") ?? []
    expect(copied).toContain("src/ui.ts")
    expect(copied.filter((path) => path.startsWith("migrations"))).toEqual([])
  })

  it("doesn't look for duplicates in a PR of only new migrations", async () => {
    const { run, seen } = fakeScanners({ jscpd: jscpdReporting([]) })
    const { checksRun, notChecked } = await scan([changed("migrations/20261102000000-add-orders.js", DB_MIGRATE_MIGRATION, [1, 2, 3])], run)
    expect(seen.has("jscpd")).toBe(false)
    expect([...checksRun, ...notChecked].map((check) => ("name" in check ? check.name : check.check))).not.toContain("jscpd")
  })

  it("reports a clone only when most of a copy is new, pointing at the other copy", async () => {
    const file = changed("src/ui.ts", NUMBERED, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 25])
    const { findings } = await scan([file], fakeScanners({ jscpd: jscpdReporting([clone("src/old.ts", 3, 14, "src/ui.ts", 1, 10), clone("src/old.ts", 3, 14, "src/ui.ts", 20, 29)]) }).run)
    expect(findings).toHaveLength(1)
    expect(findings.at(0)).toMatchObject({ ruleId: "jscpd.duplicate", category: "codeQuality", location: { path: "src/ui.ts", line: 1 }, evidence: "10 lines, also at src/old.ts:3" })
  })

  it("reports one finding when both copies are new", async () => {
    const file = changed("src/ui.ts", NUMBERED, Array.from({ length: 30 }, (_, index) => index + 1))
    const { findings } = await scan([file], fakeScanners({ jscpd: jscpdReporting([clone("src/ui.ts", 1, 10, "src/ui.ts", 11, 20)]) }).run)
    expect(findings).toHaveLength(1)
  })

  it("reports a failing scanner or unreadable output, rather than implying it found nothing", async () => {
    const { notChecked, checksRun } = await scan(
      [changed("src/app.py", NUMBERED, [1]), changed("src/ui.ts", NUMBERED, [1])],
      fakeScanners({ ruff: () => ({ exitCode: 2, stdout: "", stderr: "boom" }), oxlint: () => OK("not json"), jscpd: async () => OK("") }).run,
    )
    expect(notChecked.map((skipped) => skipped.reason)).toEqual(["it failed: boom", expect.stringContaining("output could not be read"), expect.stringContaining("report could not be read")])
    expect(checksRun).toEqual([])
  })

  it("leaves generated and vendored files out", async () => {
    const generated: ScannedFile = { ...changed("src/gen.py", NUMBERED, [1]), noise: { kind: "generated", reason: "" } }
    const { run, seen } = fakeScanners({})
    expect(await scan([generated], run)).toEqual({ findings: [], checksRun: [], notChecked: [] })
    expect(seen.size).toBe(0)
  })
})

describe("linter arguments and output", () => {
  it("keeps each linter away from any config in the scanned folder", () => {
    expect(ruffArgs()).toContain("--isolated")
    expect(oxlintArgs("/work/config.json")).toEqual(expect.arrayContaining(["-c", "/work/config.json", "--disable-nested-config"]))
  })

  it("rates likely bugs above untidiness", () => {
    const ruff = (code: string): string => JSON.stringify([{ code, filename: "/r/a.py", location: { row: 1 }, end_location: { row: 1 } }])
    expect(parseRuffOutput(ruff("F821"), "/r").at(0)).toMatchObject({ severity: "medium", path: "a.py" })
    expect(parseRuffOutput(ruff("F401"), "/r").at(0)?.severity).toBe("low")
    const oxlint = (code: string): string => JSON.stringify({ diagnostics: [{ code, filename: "src/a.ts", labels: [{ span: { line: 4 } }] }] })
    expect(parseOxlintOutput(oxlint("eslint(no-debugger)"), "/r").at(0)).toMatchObject({ severity: "medium", ruleId: "oxlint.eslint.no-debugger", title: "no debugger", line: 4, path: "src/a.ts" })
    expect(parseOxlintOutput(oxlint("eslint(no-unused-vars)"), "/r").at(0)?.severity).toBe("low")
  })

  it("skips what is not a finding about the code", () => {
    expect(parseRuffOutput(JSON.stringify([{ code: null, filename: "a.py", location: { row: 1 }, end_location: { row: 1 } }]), "/r")).toEqual([])
    expect(parseOxlintOutput(JSON.stringify({ diagnostics: [{ filename: "a.ts", labels: [{ span: { line: 1 } }] }] }), "/r")).toEqual([])
  })

  it("reads jscpd's report", () => {
    expect(parseJscpdReport(JSON.stringify({ duplicates: [clone("a.ts", 1, 12, "b.ts", 5, 16)], statistics: {} }))).toEqual([
      [{ path: "a.ts", start: 1, end: 12 }, { path: "b.ts", start: 5, end: 16 }],
    ])
  })
})
