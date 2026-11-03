import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckId } from "@walkdiff/review-model"
import type { CheckRun, Risk, SkippedCheck } from "@walkdiff/review-model"
import { isThirdParty } from "../scannedFile.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { GITLEAKS_BINARY, gitleaksArgs, parseGitleaksReport } from "./gitleaks.ts"
import { notRun, toRisks, TURNED_OFF_IN_SETTINGS, writeScanFiles } from "./scanWorkspace.ts"
import type { ScanOutcome } from "./scanWorkspace.ts"
import { firstErrorLine } from "./scannerProcess.ts"
import type { ScannerProcessRunner } from "./scannerProcess.ts"
import { parseZizmorOutput, ZIZMOR_BINARY, ZIZMOR_CONFIG_FILE, zizmorArgs } from "./zizmor.ts"
import { parseSemgrepOutput, SEMGREP_BINARY, semgrepArgs } from "./semgrep.ts"

export interface CodeScanRequest {
  readonly files: readonly ScannedFile[]
  /** Semgrep rule packs, from the config on the merge base. */
  readonly semgrepRules: readonly string[]
  /** False skips Semgrep, which downloads its rules. */
  readonly network: boolean
  readonly run: ScannerProcessRunner
  /** Checks the person turned off. */
  readonly disabled?: ReadonlySet<CheckId>
}

export interface CodeScanResult {
  readonly findings: Risk[]
  readonly checksRun: CheckRun[]
  readonly notChecked: SkippedCheck[]
}

const SEMGREP_CHECK = "Semgrep code scan"
const GITLEAKS_CHECK = "gitleaks secret scan"
const SEMGREP_INSTALL = "not installed. Run `walkdiff setup` with Python 3.10 or later available, or use `brew install semgrep`"
const ZIZMOR_CHECK = "zizmor GitHub Actions scan"
const ZIZMOR_INSTALL = "not installed. Run `walkdiff setup`, or use `brew install zizmor`"
const WORKFLOW_FILE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|action\.ya?ml)$/
const GITLEAKS_INSTALL = "not installed. Run `walkdiff setup`, or use `brew install gitleaks`"
const SEMGREP_SUCCESS_EXIT_CODE = 0
const GITLEAKS_REPORT_FILE = "gitleaks-report.json"
const SCAN_ROOT_DIR = "files"

/**
 * Files in a PR that would change how a scanner treats that same PR: a `.gitleaks.toml` with
 * an allowlist silences gitleaks entirely, and a `.semgrepignore` or `.gitignore` hides whole
 * directories.
 * They are never copied into the scan folder.
 */
const SCANNER_CONTROL_FILES: ReadonlySet<string> = new Set([".gitleaks.toml", ".gitleaksignore", ".gitleaks.baseline", ".semgrepignore", ".semgrep.yml", ".semgrep.yaml", ".semgrepconfig.yml", "zizmor.yml", ".gitignore"])
// Semgrep's built-in ignore list skips tests and more when no ignore file exists; an empty
// one means every copied file is scanned.
const EMPTY_IGNORE_FILE = ".semgrepignore"

/**
 * Runs the installed code scanners over the head version of the changed files, keeping only
 * findings on lines this PR added: anything else was already there before the change.
 */
export async function runCodeScanners(request: CodeScanRequest): Promise<CodeScanResult> {
  const candidates = request.files.filter((file) => file.after !== undefined && !isThirdParty(file) && !isScannerControlPath(file.diff.path))
  if (candidates.length === 0) {
    return { findings: [], checksRun: [], notChecked: [] }
  }

  const workspace = await mkdtemp(join(tmpdir(), "walkdiff-scan-"))
  try {
    const root = join(workspace, SCAN_ROOT_DIR)
    await mkdir(root, { recursive: true })
    await copyFiles(root, candidates)
    await writeFile(join(root, EMPTY_IGNORE_FILE), "")
    const outcomes = await Promise.all([runSemgrep(request, root), runGitleaks(request, root, workspace), runZizmor(request, root, workspace)])
    return {
      findings: toRisks(outcomes.flatMap((outcome) => outcome.findings), candidates),
      checksRun: outcomes.flatMap((outcome) => outcome.checksRun),
      notChecked: outcomes.flatMap((outcome) => outcome.notChecked),
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

// Any segment, not only the file name: a folder called `.semgrepignore` would stop the empty
// ignore file being written.
function isScannerControlPath(path: string): boolean {
  return path.split("/").some((segment) => SCANNER_CONTROL_FILES.has(segment))
}

async function copyFiles(root: string, files: readonly ScannedFile[]): Promise<void> {
  await writeScanFiles(root, files.flatMap((file) => (file.after === undefined ? [] : [{ path: file.diff.path, text: file.after }])))
}

async function runSemgrep(request: CodeScanRequest, root: string): Promise<ScanOutcome> {
  if (request.disabled?.has(CheckId.Semgrep)) return notRun(SEMGREP_CHECK, TURNED_OFF_IN_SETTINGS)
  if (request.semgrepRules.length === 0) return notRun(SEMGREP_CHECK, "turned off in .walkdiff.json")
  if (!request.network) return notRun(SEMGREP_CHECK, "offline mode: Semgrep downloads its rules")
  const result = await request.run(SEMGREP_BINARY, semgrepArgs(request.semgrepRules), root)
  if (result === undefined) return notRun(SEMGREP_CHECK, SEMGREP_INSTALL)
  if (result.exitCode !== SEMGREP_SUCCESS_EXIT_CODE) return notRun(SEMGREP_CHECK, `it failed: ${firstErrorLine(result)}`)
  try {
    return { findings: parseSemgrepOutput(result.stdout), checksRun: [{ name: "Semgrep", detail: `rules: ${request.semgrepRules.join(", ")}` }], notChecked: [] }
  } catch (error: unknown) {
    return notRun(SEMGREP_CHECK, `its output could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runZizmor(request: CodeScanRequest, root: string, workspace: string): Promise<ScanOutcome> {
  // A PR with no GitHub workflows has nothing for it to check, which is every GitLab project.
  if (!request.files.some((file) => WORKFLOW_FILE.test(file.diff.path) && file.after !== undefined)) return { findings: [], checksRun: [], notChecked: [] }
  if (request.disabled?.has(CheckId.Zizmor)) return notRun(ZIZMOR_CHECK, TURNED_OFF_IN_SETTINGS)
  const configPath = join(workspace, ZIZMOR_CONFIG_FILE)
  await writeFile(configPath, "rules: {}\n")
  const result = await request.run(ZIZMOR_BINARY, zizmorArgs(configPath), root)
  if (result === undefined) return notRun(ZIZMOR_CHECK, ZIZMOR_INSTALL)
  if (result.exitCode !== 0) return notRun(ZIZMOR_CHECK, `it failed: ${firstErrorLine(result)}`)
  try {
    return { findings: parseZizmorOutput(result.stdout, root), checksRun: [{ name: "zizmor", detail: "GitHub Actions workflows" }], notChecked: [] }
  } catch (error: unknown) {
    return notRun(ZIZMOR_CHECK, `its output could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runGitleaks(request: CodeScanRequest, root: string, workspace: string): Promise<ScanOutcome> {
  if (request.disabled?.has(CheckId.Gitleaks)) return notRun(GITLEAKS_CHECK, TURNED_OFF_IN_SETTINGS)
  // The report goes outside the scanned folder, so gitleaks cannot scan its own output.
  const reportPath = join(workspace, GITLEAKS_REPORT_FILE)
  const result = await request.run(GITLEAKS_BINARY, gitleaksArgs(reportPath), root)
  if (result === undefined) return notRun(GITLEAKS_CHECK, GITLEAKS_INSTALL)
  if (result.exitCode !== 0) return notRun(GITLEAKS_CHECK, `it failed: ${firstErrorLine(result)}`)
  try {
    return { findings: parseGitleaksReport(await readFile(reportPath, "utf8")), checksRun: [{ name: "gitleaks", detail: "default rules" }], notChecked: [] }
  } catch (error: unknown) {
    return notRun(GITLEAKS_CHECK, `its report could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}
