import { readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CheckId } from "@walkdiff/review-model"
import type { FileDiff } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { parseOsvScannerOutput } from "../dependencies/osvScanner.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { gitleaksArgs, parseGitleaksReport } from "./gitleaks.ts"
import { runCodeScanners } from "./runCodeScanners.ts"
import { scannerExecutable } from "./scannerProcess.ts"
import type { ProcessResult, ScannerProcessRunner } from "./scannerProcess.ts"
import { parsePoutineOutput, poutineArgs } from "./poutine.ts"
import { parseRuffSecurityOutput, ruffSecurityArgs } from "./ruffSecurity.ts"
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
function fakeScanners(outcomes: { semgrep?: ProcessResult | undefined; gitleaks?: object[] | undefined; gitleaksExit?: number; ruff?: ProcessResult | undefined }): Fake {
  const seen: Fake["seen"] = new Map()
  const run: ScannerProcessRunner = async (binary, args, cwd) => {
    seen.set(binary, { files: (await readdir(cwd, { recursive: true })).map(String), args })
    if (binary === "semgrep") return outcomes.semgrep
    if (binary === "ruff") return outcomes.ruff
    if (binary !== "gitleaks" || outcomes.gitleaks === undefined) return undefined
    const reportPath = args.at(args.indexOf("--report-path") + 1) ?? ""
    await writeFile(reportPath, JSON.stringify(outcomes.gitleaks))
    return { exitCode: outcomes.gitleaksExit ?? 0, stdout: "", stderr: "" }
  }
  return { run, seen }
}

const request = (files: readonly ScannedFile[], run: ScannerProcessRunner, network = true) => ({ files, semgrepRules: ["p/default"], network, run })

describe("runCodeScanners", () => {
  it("keeps only findings on lines the PR added", async () => {
    const file = modifiedFile("src/app.js", "old()\nnew()\n", [2])
    const { run } = fakeScanners({ semgrep: { exitCode: 0, stdout: JSON.stringify({ results: [semgrepResult("src/app.js", 1), semgrepResult("src/app.js", 2)] }), stderr: "" }, gitleaks: [] })
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
    const file = modifiedFile("a.js", "x", [1])
    const missing = await runCodeScanners(request([file], run))
    expect(missing.notChecked.map((skipped) => skipped.reason)).toEqual([expect.stringContaining("install"), expect.stringContaining("brew install gitleaks")])
    expect(missing.checksRun).toEqual([])
    const offline = await runCodeScanners(request([file], run, false))
    expect(offline.notChecked.at(0)?.reason).toContain("offline")
  })

  it("skips a check the person turned off, and says so instead of pretending it ran", async () => {
    const { run, seen } = fakeScanners({ semgrep: { exitCode: 0, stdout: '{"results":[]}', stderr: "" }, gitleaks: [] })
    const { notChecked, checksRun } = await runCodeScanners({ ...request([modifiedFile("a.js", "x", [1])], run), disabled: new Set(["semgrep"]) })
    expect(notChecked).toEqual([{ check: "Semgrep code scan", reason: "turned off in your settings" }])
    expect(checksRun.map((check) => check.name)).toEqual(["gitleaks"])
    expect(seen.has("semgrep")).toBe(false)
  })

  it("reports a scanner that fails, rather than implying it found nothing", async () => {
    const { run } = fakeScanners({ semgrep: { exitCode: 2, stdout: "", stderr: "\nInvalid rule\nmore" }, gitleaks: [] })
    const { notChecked, checksRun } = await runCodeScanners(request([modifiedFile("a.js", "x", [1])], run))
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

describe("Ruff security rules", () => {
  const PYTHON = "import subprocess\nsubprocess.run(cmd, shell=True)\nyaml.load(text)\n"
  const ruffResult = (path: string, row: number, code: string): object => ({ code, name: "subprocess-popen-with-shell-equals-true", filename: path, location: { row }, end_location: { row }, url: `https://docs.astral.sh/ruff/rules/${code}` })
  const ruffReporting = (...results: object[]): ProcessResult => ({ exitCode: 0, stdout: JSON.stringify(results), stderr: "" })
  const OK_SEMGREP: ProcessResult = { exitCode: 0, stdout: '{"results":[]}', stderr: "" }

  it("reports Bandit's findings on added Python lines as code scan findings", async () => {
    const { run, seen } = fakeScanners({ semgrep: OK_SEMGREP, gitleaks: [], ruff: ruffReporting(ruffResult("src/app.py", 2, "S602"), ruffResult("src/app.py", 1, "S602")) })
    const { findings, checksRun } = await runCodeScanners(request([modifiedFile("src/app.py", PYTHON, [2])], run))
    expect(findings).toMatchObject([{ ruleId: "ruff-security.S602", category: "codeScan", severity: "medium", title: "subprocess popen with shell equals true", location: { path: "src/app.py", line: 2 } }])
    expect(checksRun.map((check) => check.name)).toContain("Ruff security rules")
    expect(seen.get("ruff")?.args).toEqual(ruffSecurityArgs())
  })

  it("matches the absolute, symlink-free paths Ruff reports", async () => {
    const run: ScannerProcessRunner = async (binary, _args, cwd) => (binary === "ruff" ? ruffReporting(ruffResult(join(await realpath(cwd), "src/app.py"), 2, "S602")) : undefined)
    const { findings } = await runCodeScanners(request([modifiedFile("src/app.py", PYTHON, [2])], run))
    expect(findings.map((finding) => finding.location?.path)).toEqual(["src/app.py"])
  })

  it("still checks Python offline, when Semgrep can't download its rules", async () => {
    const { run } = fakeScanners({ gitleaks: [], ruff: ruffReporting(ruffResult("src/app.py", 2, "S602")) })
    const { findings, checksRun } = await runCodeScanners(request([modifiedFile("src/app.py", PYTHON, [2])], run, false))
    expect(findings.map((finding) => finding.ruleId)).toEqual(["ruff-security.S602"])
    expect(checksRun.map((check) => check.name)).not.toContain("Semgrep")
  })

  it("leaves out test files and rules outside the chosen set", () => {
    const output = JSON.stringify([ruffResult("/r/tests/test_app.py", 1, "S301"), ruffResult("/r/app.py", 1, "S101"), ruffResult("/r/app.py", 2, "S324")])
    expect(parseRuffSecurityOutput(output, "/r")).toMatchObject([{ ruleId: "ruff-security.S324", severity: "low", path: "app.py", line: 2 }])
  })

  it("selects only the chosen rules, ignoring the repository's Ruff config", () => {
    const args = ruffSecurityArgs()
    const selected = args.at(args.indexOf("--select") + 1)?.split(",") ?? []
    expect(args).toContain("--isolated")
    expect(selected).toEqual(expect.arrayContaining(["S602", "S506", "S301"]))
    expect(selected).not.toContain("S101")
  })

  it.each([
    ["not installed", undefined, new Set<CheckId>(), "brew install ruff"],
    ["turned off with Ruff", { exitCode: 0, stdout: "[]", stderr: "" }, new Set<CheckId>([CheckId.Ruff]), "turned off in your settings"],
    ["failing", { exitCode: 2, stdout: "", stderr: "error: bad selector" }, new Set<CheckId>(), "it failed: error: bad selector"],
  ])("says why it didn't run when %s", async (_case, ruff, disabled, reason) => {
    const { run } = fakeScanners({ semgrep: OK_SEMGREP, gitleaks: [], ruff })
    const { notChecked } = await runCodeScanners({ ...request([modifiedFile("src/app.py", PYTHON, [2])], run), disabled })
    expect(notChecked.find((skipped) => skipped.check === "Ruff security rules")?.reason).toContain(reason)
  })

  it("doesn't run without a Python file in the change", async () => {
    const { run, seen } = fakeScanners({ semgrep: OK_SEMGREP, gitleaks: [] })
    const { notChecked } = await runCodeScanners(request([modifiedFile("src/app.ts", "x", [1])], run))
    expect(seen.has("ruff")).toBe(false)
    expect(notChecked).toEqual([])
  })
})

describe("poutine", () => {
  const CI = "variables:\n  CI_DEBUG_TRACE: \"true\"\ndeploy:\n  script:\n    - curl https://get.example.sh | sh\n"
  const RULES = {
    unverified_script_exec: { title: "Unverified Script Execution", description: "The pipeline executes a script\nfetched from a remote server.", level: "note" },
    debug_enabled: { title: "CI Runner Debug Enabled", description: "Verbose runner.", level: "note" },
    injection: { title: "Injection", description: "Injection.", level: "warning" },
    untrusted_checkout_exec: { title: "Untrusted checkout", description: "Checkout.", level: "error" },
  }
  const output = (findings: readonly object[] | null): string => JSON.stringify({ findings, rules: RULES, packages: {} })
  const pipeline = [{ path: ".gitlab-ci.yml", text: CI, system: "gitlabCi" }, { path: "ci/base.yml", text: "image: ruby\n", system: "gitlabCi" }] as const

  it("reports findings with poutine's title and description, at their line", () => {
    const findings = parsePoutineOutput(output([{ rule_id: "unverified_script_exec", meta: { path: ".gitlab-ci.yml", line: 5, details: "Command: curl https://get.example.sh | sh", job: "deploy" } }]), "/root", new Map())
    expect(findings).toEqual([{
      ruleId: "poutine.unverified_script_exec",
      category: "codeScan",
      severity: "medium",
      title: "Unverified Script Execution",
      detail: "Command: curl https://get.example.sh | sh. The pipeline executes a script fetched from a remote server. Reported by poutine.",
      path: ".gitlab-ci.yml",
      line: 5,
      endLine: 5,
      showLine: true,
    }])
  })

  it("places a finding without a line on the first line naming what it found", () => {
    const findings = parsePoutineOutput(output([{ rule_id: "debug_enabled", meta: { path: ".gitlab-ci.yml", details: "CI_DEBUG_TRACE" } }]), "/root", new Map([[".gitlab-ci.yml", CI]]))
    expect(findings.map((finding) => [finding.line, finding.severity])).toEqual([[2, "medium"]])
  })

  it.each([
    ["error", "untrusted_checkout_exec", "high"],
    ["warning", "injection", "medium"],
  ])("rates poutine's %s level", (_level, ruleId, severity) => {
    expect(parsePoutineOutput(output([{ rule_id: ruleId, meta: { path: "a.yml", line: 1 } }]), "/root", new Map()).at(0)?.severity).toBe(severity)
  })

  it("drops findings it can't place, and reads an empty result", () => {
    expect(parsePoutineOutput(output([{ rule_id: "debug_enabled", meta: { path: "a.yml", details: "CI_DEBUG_TRACE" } }, { rule_id: "injection", meta: {} }]), "/root", new Map())).toEqual([])
    expect(parsePoutineOutput(output(null), "/root", new Map())).toEqual([])
  })

  it("scans the whole pipeline in its own folder, with Walkdiff's config, and keeps findings on added lines", async () => {
    let copied: string[] = []
    let args: readonly string[] = []
    let scannedFolder = ""
    const run: ScannerProcessRunner = async (binary, given, cwd) => {
      if (binary !== "poutine") return undefined
      copied = (await readdir(cwd, { recursive: true })).map(String)
      args = given
      scannedFolder = cwd
      return { exitCode: 0, stdout: output([{ rule_id: "unverified_script_exec", meta: { path: ".gitlab-ci.yml", line: 5 } }, { rule_id: "injection", meta: { path: "ci/base.yml", line: 1 } }]), stderr: "" }
    }
    const { findings, checksRun } = await runCodeScanners({ ...request([modifiedFile(".gitlab-ci.yml", CI, [5])], run), pipelineFiles: pipeline })
    expect(copied.sort()).toEqual([".gitlab-ci.yml", "ci", "ci/base.yml"])
    const configPath = args.at(-1) ?? ""
    expect(args).toEqual(poutineArgs(configPath))
    // Outside the scanned folder, so no file in the change can stand in for it.
    expect(configPath.startsWith(scannedFolder)).toBe(false)
    expect(findings.map((finding) => [finding.ruleId, finding.location?.line])).toEqual([["poutine.unverified_script_exec", 5]])
    expect(checksRun.map((check) => check.name)).toContain("poutine")
  })

  it("doesn't run when the change touches no pipeline", async () => {
    const { run, seen } = fakeScanners({ semgrep: { exitCode: 0, stdout: '{"results":[]}', stderr: "" }, gitleaks: [] })
    const { notChecked } = await runCodeScanners({ ...request([modifiedFile("k8s/app.yaml", "x", [1])], run), pipelineFiles: [] })
    expect(seen.has("poutine")).toBe(false)
    expect(notChecked).toEqual([])
  })

  it.each([
    ["not installed", undefined, new Set<CheckId>(), "brew install poutine"],
    ["turned off", { exitCode: 0, stdout: output([]), stderr: "" }, new Set<CheckId>([CheckId.Poutine]), "turned off in your settings"],
    ["failing", { exitCode: 1, stdout: "", stderr: "Error: boom" }, new Set<CheckId>(), "it failed: Error: boom"],
  ])("says why it didn't run when %s", async (_case, result, disabled, reason) => {
    const run: ScannerProcessRunner = async (binary) => (binary === "poutine" ? result : undefined)
    const { notChecked } = await runCodeScanners({ ...request([modifiedFile(".gitlab-ci.yml", CI, [5])], run), pipelineFiles: pipeline, disabled })
    expect(notChecked.find((skipped) => skipped.check === "poutine CI pipeline scan")?.reason).toContain(reason)
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
