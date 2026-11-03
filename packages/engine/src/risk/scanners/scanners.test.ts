import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { FileDiff } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { parseOsvScannerOutput } from "../dependencies/osvScanner.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { gitleaksArgs, parseGitleaksReport } from "./gitleaks.ts"
import { runCodeScanners } from "./runCodeScanners.ts"
import { scannerExecutable } from "./scannerProcess.ts"
import type { ProcessResult, ScannerProcessRunner } from "./scannerProcess.ts"
import { parseSemgrepOutput, semgrepArgs } from "./semgrep.ts"
import { parseZizmorOutput, zizmorArgs } from "./zizmor.ts"

function modifiedFile(path: string, content: string, addedLineNumbers: readonly number[]): ScannedFile {
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

const semgrepResult = (path: string, line: number, checkId = "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true"): object => ({
  check_id: checkId,
  path,
  start: { line },
  end: { line },
  extra: { severity: "ERROR", message: "Found shell=True." },
})

interface Fake {
  readonly run: ScannerProcessRunner
  readonly seen: Map<string, { readonly files: readonly string[]; readonly args: readonly string[] }>
}

/** Stands in for the binaries, recording what each was given. */
function fakeScanners(outcomes: { semgrep?: ProcessResult | undefined; gitleaks?: object[] | undefined; gitleaksExit?: number }): Fake {
  const seen: Fake["seen"] = new Map()
  const run: ScannerProcessRunner = async (binary, args, cwd) => {
    seen.set(binary, { files: (await readdir(cwd, { recursive: true })).map(String), args })
    if (binary === "semgrep") return outcomes.semgrep
    if (outcomes.gitleaks === undefined) return undefined
    const reportPath = args.at(args.indexOf("--report-path") + 1) ?? ""
    await writeFile(reportPath, JSON.stringify(outcomes.gitleaks))
    return { exitCode: outcomes.gitleaksExit ?? 0, stdout: "", stderr: "" }
  }
  return { run, seen }
}

const request = (files: readonly ScannedFile[], run: ScannerProcessRunner, network = true) => ({ files, semgrepRules: ["p/default"], network, run })

describe("runCodeScanners", () => {
  it("keeps only findings on lines the PR added", async () => {
    const file = modifiedFile("src/app.py", "old()\nnew()\n", [2])
    const { run } = fakeScanners({ semgrep: { exitCode: 0, stdout: JSON.stringify({ results: [semgrepResult("src/app.py", 1), semgrepResult("src/app.py", 2)] }), stderr: "" }, gitleaks: [] })
    const { findings, checksRun, notChecked } = await runCodeScanners(request([file], run))
    expect(findings.map((finding) => finding.location?.line)).toEqual([2])
    expect(findings.at(0)).toMatchObject({ category: "codeScan", severity: "high", title: "subprocess shell true", evidence: "new()" })
    expect(checksRun.map((check) => check.name)).toEqual(["Semgrep", "gitleaks"])
    expect(notChecked).toEqual([])
  })

  it("does not copy files a PR could use to silence a scanner, and neutralizes the ignore file", async () => {
    const files = [modifiedFile("src/app.py", "x\n", [1]), modifiedFile(".gitleaks.toml", "[allowlist]\npaths=['.*']\n", [1]), modifiedFile("deep/.gitleaksignore", "x\n", [1]), modifiedFile(".semgrepignore", "src/\n", [1])]
    const { run, seen } = fakeScanners({ semgrep: { exitCode: 0, stdout: '{"results":[]}', stderr: "" }, gitleaks: [] })
    await runCodeScanners(request(files, run))
    const copied = seen.get("gitleaks")?.files ?? []
    expect(copied).toContain("src/app.py")
    expect(copied).not.toContain(".gitleaks.toml")
    expect(copied.some((name) => name.endsWith(".gitleaksignore"))).toBe(false)
  })

  it("scans with an empty ignore file, so a PR's or Semgrep's default ignores do not apply", async () => {
    let ignore: string | undefined
    const run: ScannerProcessRunner = async (binary, _args, cwd) => {
      if (binary === "semgrep") ignore = await readFile(join(cwd, ".semgrepignore"), "utf8")
      return undefined
    }
    await runCodeScanners(request([modifiedFile(".semgrepignore", "src/\n", [1]), modifiedFile("a.py", "x", [1])], run))
    expect(ignore).toBe("")
  })

  it("passes the flags that stop a PR hiding findings with comments", () => {
    expect(semgrepArgs(["p/default"])).toContain("--disable-nosem")
    expect(gitleaksArgs("/tmp/r.json")).toEqual(expect.arrayContaining(["--ignore-gitleaks-allow", "--redact"]))
  })

  it("never puts a secret into the report", async () => {
    // Built from parts so secret scanners do not flag this fake key in the repository.
    const secret = ["AKIA", "Q3EGUJKLMNOPQRST"].join("")
    const file = modifiedFile("src/a.py", `KEY = "${secret}"\ncall("${secret}")\n`, [1, 2])
    const { run } = fakeScanners({
      semgrep: { exitCode: 0, stdout: JSON.stringify({ results: [semgrepResult("src/a.py", 1, "generic.secrets.security.aws-key"), semgrepResult("src/a.py", 2, "python.lang.other.rule")] }), stderr: "" },
      gitleaks: [{ RuleID: "aws-access-token", Description: "AWS key", File: "src/a.py", StartLine: 1, EndLine: 1 }],
    })
    const { findings } = await runCodeScanners(request([file], run))
    expect(findings).toHaveLength(3)
    expect(JSON.stringify(findings)).not.toContain(secret)
    expect(findings.find((finding) => finding.ruleId === "semgrep.generic.secrets.security.aws-key")).toMatchObject({ category: "secret", evidence: null })
  })

  it("lists missing scanners with how to install them, and offline mode, without failing", async () => {
    const { run } = fakeScanners({})
    const file = modifiedFile("a.py", "x", [1])
    const missing = await runCodeScanners(request([file], run))
    expect(missing.notChecked.map((skipped) => skipped.reason)).toEqual([expect.stringContaining("install"), expect.stringContaining("brew install gitleaks")])
    expect(missing.checksRun).toEqual([])
    const offline = await runCodeScanners(request([file], run, false))
    expect(offline.notChecked.at(0)?.reason).toContain("offline")
  })

  it("skips a check the person turned off, and says so instead of pretending it ran", async () => {
    const { run, seen } = fakeScanners({ semgrep: { exitCode: 0, stdout: '{"results":[]}', stderr: "" }, gitleaks: [] })
    const { notChecked, checksRun } = await runCodeScanners({ ...request([modifiedFile("a.py", "x", [1])], run), disabled: new Set(["semgrep"]) })
    expect(notChecked).toEqual([{ check: "Semgrep code scan", reason: "turned off in your settings" }])
    expect(checksRun.map((check) => check.name)).toEqual(["gitleaks"])
    expect(seen.has("semgrep")).toBe(false)
  })

  it("reports a scanner that fails, rather than implying it found nothing", async () => {
    const { run } = fakeScanners({ semgrep: { exitCode: 2, stdout: "", stderr: "\nInvalid rule\nmore" }, gitleaks: [] })
    const { notChecked, checksRun } = await runCodeScanners(request([modifiedFile("a.py", "x", [1])], run))
    expect(notChecked).toEqual([{ check: "Semgrep code scan", reason: "it failed: Invalid rule" }])
    expect(checksRun.map((check) => check.name)).toEqual(["gitleaks"])
  })

  it("does nothing when no file can be scanned", async () => {
    const file = { ...modifiedFile("vendor/a.py", "x", [1]), noise: { kind: "vendored", reason: "" } } as const
    const { run, seen } = fakeScanners({})
    expect(await runCodeScanners(request([file], run))).toEqual({ findings: [], checksRun: [], notChecked: [] })
    expect(seen.size).toBe(0)
  })
})

describe("zizmor", () => {
  const WORKFLOW = ".github/workflows/ci.yml"
  const zizmorResult = (path: string, row: number, severity = "High"): object => ({
    ident: "template-injection",
    desc: "code injection via template expansion",
    url: "https://docs.zizmor.sh/audits/#template-injection",
    determinations: { confidence: "High", severity, persona: "Regular" },
    locations: [
      { symbolic: { key: { Local: { verbatim_path: path } }, kind: "Related" }, concrete: { location: { start_point: { row: 0, column: 0 }, end_point: { row: 0, column: 1 } } } },
      { symbolic: { key: { Local: { verbatim_path: path } }, kind: "Primary" }, concrete: { location: { start_point: { row, column: 0 }, end_point: { row, column: 5 } } } },
    ],
    ignored: false,
  })

  it("runs only on a PR that changes a workflow", async () => {
    const seen: string[] = []
    const run: ScannerProcessRunner = async (binary) => {
      seen.push(binary)
      return undefined
    }
    await runCodeScanners(request([modifiedFile("a.py", "x", [1])], run))
    expect(seen).not.toContain("zizmor")
    await runCodeScanners(request([modifiedFile(WORKFLOW, "x", [1])], run))
    expect(seen).toContain("zizmor")
  })

  it("keeps findings on added lines, and counts lines from 1 as the report does", async () => {
    const run: ScannerProcessRunner = async (binary) => (binary === "zizmor" ? { exitCode: 0, stdout: JSON.stringify([zizmorResult(`./${WORKFLOW}`, 1), zizmorResult(`./${WORKFLOW}`, 0)]), stderr: "" } : undefined)
    const { findings, checksRun } = await runCodeScanners(request([modifiedFile(WORKFLOW, "a\nb\n", [2])], run))
    expect(findings).toMatchObject([{ ruleId: "zizmor.template-injection", category: "codeScan", severity: "high", title: "template injection", location: { path: WORKFLOW, line: 2 } }])
    expect(checksRun.map((check) => check.name)).toContain("zizmor")
  })

  it("can't be silenced by the PR: no ignores, its own config, and PR config files aren't copied", async () => {
    const args = zizmorArgs("/work/config.yml")
    expect(args).toEqual(expect.arrayContaining(["--no-ignores", "--offline", "--config", "/work/config.yml", "--no-exit-codes"]))
    let copied: readonly string[] = []
    const run: ScannerProcessRunner = async (binary, _args, cwd) => {
      if (binary === "zizmor") copied = (await readdir(cwd, { recursive: true })).map(String)
      return undefined
    }
    await runCodeScanners(request([modifiedFile(WORKFLOW, "x", [1]), modifiedFile("zizmor.yml", "rules: {}", [1]), modifiedFile(".github/zizmor.yml", "rules: {}", [1]), modifiedFile(".gitignore", ".github", [1])], run))
    expect(copied.some((name) => name.endsWith("zizmor.yml"))).toBe(false)
    expect(copied).not.toContain(".gitignore")
  })

  it.each([
    [{ exitCode: 1, stdout: "", stderr: "fatal: bad workflow" }, "it failed: fatal: bad workflow"],
    [{ exitCode: 0, stdout: "not json", stderr: "" }, "its output could not be read"],
    [undefined, "brew install zizmor"],
  ])("says why it didn't run: %j", async (result, reason) => {
    const run: ScannerProcessRunner = async (binary) => (binary === "zizmor" ? result : undefined)
    const { notChecked } = await runCodeScanners(request([modifiedFile(WORKFLOW, "x", [1])], run))
    expect(notChecked.find((skipped) => skipped.check.startsWith("zizmor"))?.reason).toContain(reason)
  })

  it("respects the setting that turns it off", async () => {
    const run: ScannerProcessRunner = async () => undefined
    const { notChecked } = await runCodeScanners({ ...request([modifiedFile(WORKFLOW, "x", [1])], run), disabled: new Set(["zizmor"]) })
    expect(notChecked.find((skipped) => skipped.check.startsWith("zizmor"))?.reason).toBe("turned off in your settings")
  })

  it("rates a tag instead of a pinned commit below code injection", () => {
    const finding = { ...zizmorResult("a.yml", 0, "High"), ident: "unpinned-uses" }
    expect(parseZizmorOutput(JSON.stringify([finding]), "/root").at(0)?.severity).toBe("medium")
  })

  it("reads severities, treating an unknown one as medium", () => {
    const severity = (value: string): string | undefined => parseZizmorOutput(JSON.stringify([zizmorResult("a.yml", 0, value)]), "/root").at(0)?.severity
    expect([severity("High"), severity("Medium"), severity("Low"), severity("Informational"), severity("New")]).toEqual(["high", "medium", "low", "low", "medium"])
  })
})

describe("scanner output parsing", () => {
  it("reads Semgrep severities", () => {
    const output = (severity: string): string => JSON.stringify({ results: [{ ...semgrepResult("a", 1), extra: { severity, message: "m" } }] })
    expect(parseSemgrepOutput(output("ERROR")).at(0)?.severity).toBe("high")
    expect(parseSemgrepOutput(output("WARNING")).at(0)?.severity).toBe("medium")
    expect(parseSemgrepOutput(output("INFO")).at(0)?.severity).toBe("low")
  })

  it("reads a gitleaks report and an empty one", () => {
    expect(parseGitleaksReport("[]")).toEqual([])
    expect(parseGitleaksReport(JSON.stringify([{ RuleID: "aws-access-token", Description: "d", File: "a", StartLine: 3, EndLine: 3 }])).at(0)).toMatchObject({ ruleId: "gitleaks.aws-access-token", category: "secret", severity: "high", line: 3, showLine: false })
  })

  it("reads osv-scanner's packages and severities", () => {
    const output = {
      results: [
        {
          packages: [
            {
              package: { name: "lodash", version: "4.17.15", ecosystem: "npm" },
              vulnerabilities: [{ id: "GHSA-1", summary: "bad", aliases: ["CVE-1"], database_specific: { severity: "MODERATE" }, affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ events: [{ fixed: "4.17.21" }] }] }] }],
            },
          ],
        },
      ],
    }
    expect(parseOsvScannerOutput(JSON.stringify(output))).toEqual([
      { package: { ecosystem: "npm", name: "lodash", version: "4.17.15" }, vulnerability: { id: "GHSA-1", aliases: ["CVE-1"], summary: "bad", severity: "medium", fixedIn: "4.17.21" } },
    ])
    expect(parseOsvScannerOutput("{}")).toEqual([])
  })
})

describe("scannerExecutable", () => {
  it("prefers the first directory holding the binary", () => {
    expect(scannerExecutable("semgrep", (path) => path.startsWith("/second"), ["/first", "/second"])).toBe("/second/semgrep")
  })

  it("uses the bundled copy when there is one", () => {
    expect(scannerExecutable("jscpd", () => true, ["/bin-dir"])).toBe("/bin-dir/jscpd")
  })

  it("looks anything else up on the PATH", () => {
    expect(scannerExecutable("semgrep", () => false, ["/bin-dir"])).toBe("semgrep")
  })

  it("finds the scanners that ship with Walkdiff", () => {
    expect(scannerExecutable("oxlint")).toContain("node_modules")
    expect(scannerExecutable("jscpd")).toContain("node_modules")
  })
})
