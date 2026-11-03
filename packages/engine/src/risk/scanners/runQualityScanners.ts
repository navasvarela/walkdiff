import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { CheckId, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { CommitSha, Risk } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import { listSourceFiles, SCAN_BATCH_FILES } from "../../impact/candidateFiles.ts"
import { MAX_SOURCE_FILE_BYTES } from "../../limits.ts"
import { addedLines, findingAt } from "../scannedFile.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { isTestPath } from "../testCode.ts"
import { JSCPD_BINARY, jscpdArgs, JSCPD_REPORT_FILE, parseJscpdReport } from "./jscpd.ts"
import type { Clone, CloneSide } from "./jscpd.ts"
import { OXLINT_BINARY, oxlintArgs, parseOxlintOutput } from "./oxlint.ts"
import { parseRuffOutput, RUFF_BINARY, ruffArgs } from "./ruff.ts"
import { notRun, pathInScanRoot, toRisks, TURNED_OFF_IN_SETTINGS, writeScanFiles } from "./scanWorkspace.ts"
import type { ScanOutcome } from "./scanWorkspace.ts"
import type { ScannerFinding } from "./scannerFinding.ts"
import { firstErrorLine } from "./scannerProcess.ts"
import type { ProcessResult, ScannerProcessRunner } from "./scannerProcess.ts"

export interface QualityScanRequest {
  readonly repoDir: string
  readonly head: CommitSha
  readonly files: readonly ScannedFile[]
  readonly isIgnored: (path: string) => boolean
  readonly run: ScannerProcessRunner
  /** Checks the person turned off. */
  readonly disabled?: ReadonlySet<CheckId>
}

/**
 * Only source files are ever copied into a scan folder, so a config file in the PR (`ruff.toml`,
 * `.oxlintrc.json`, `.jscpd.json`, a `jscpd` key in `package.json`) cannot change the results.
 * Dotfiles and `*.config.*` are left out because they are source by extension but config in effect.
 */
const CONFIG_LIKE_FILE = /^\.|\.config\.[^.]+$/
const PYTHON_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".pyi"])
const ECMASCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
const OXLINT_OK_EXIT_CODES: ReadonlySet<number> = new Set([0, 1])
const SUCCESS_ONLY: ReadonlySet<number> = new Set([0])
// Past this the copy to disk takes longer than a review is worth waiting for.
const MAX_DUPLICATION_SOURCE_FILES = 20_000
// A one-line edit inside an existing clone is not this PR's duplication; most of the block must be new.
const MIN_ADDED_SHARE_OF_CLONE = 0.5

interface ScannerIdentity {
  readonly id: CheckId
  readonly check: string
  readonly name: string
  readonly detail: string
  readonly install: string
}

const RUFF: ScannerIdentity = { id: CheckId.Ruff, check: "Ruff Python lint", name: "Ruff", detail: "likely bugs and bad practice in Python", install: "not installed. Run `pnpm install` in Walkdiff, or use `brew install ruff`" }
const OXLINT: ScannerIdentity = { id: CheckId.Oxlint, check: "oxlint TypeScript lint", name: "oxlint", detail: "likely bugs in TypeScript and JavaScript", install: "missing from this install; run `pnpm install` in the Walkdiff folder" }
const JSCPD: ScannerIdentity = { id: CheckId.Jscpd, check: "jscpd duplicate detection", name: "jscpd", detail: "new code copied from elsewhere in the repository", install: "missing from this install; run `pnpm install` in the Walkdiff folder" }

/** Runs the installed linters and duplicate detection; none of them use the network. */
export async function runQualityScanners(request: QualityScanRequest): Promise<ScanOutcome<Risk>> {
  const candidates = request.files.filter(isFirstPartySource)
  if (candidates.length === 0) return { findings: [], checksRun: [], notChecked: [] }

  const workspace = await realpath(await mkdtemp(join(tmpdir(), "walkdiff-quality-")))
  try {
    const outcomes = await Promise.all([
      runLinter(request, candidates, workspace, RUFF, PYTHON_EXTENSIONS, runRuff),
      runLinter(request, candidates, workspace, OXLINT, ECMASCRIPT_EXTENSIONS, runOxlint),
      runJscpd(request, candidates, workspace),
    ])
    return {
      findings: outcomes.flatMap((outcome) => outcome.findings),
      checksRun: outcomes.flatMap((outcome) => outcome.checksRun),
      notChecked: outcomes.flatMap((outcome) => outcome.notChecked),
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function isFirstPartySource(file: ScannedFile): boolean {
  return file.after !== undefined && file.noise === null && !CONFIG_LIKE_FILE.test(basename(file.diff.path))
}

type LinterRun = (run: ScannerProcessRunner, root: string, workspace: string) => Promise<LinterResult>
interface LinterResult {
  readonly result: ProcessResult | undefined
  readonly okExitCodes: ReadonlySet<number>
  readonly parse: (stdout: string) => ScannerFinding[]
}

async function runLinter(request: QualityScanRequest, candidates: readonly ScannedFile[], workspace: string, scanner: ScannerIdentity, extensions: ReadonlySet<string>, lint: LinterRun): Promise<ScanOutcome<Risk>> {
  if (request.disabled?.has(scanner.id)) return notRun(scanner.check, TURNED_OFF_IN_SETTINGS)
  const files = candidates.filter((file) => extensions.has(extname(file.diff.path)))
  // A PR with no files for this linter has nothing it could have checked.
  if (files.length === 0) return { findings: [], checksRun: [], notChecked: [] }
  const root = await prepareScanRoot(workspace, scanner.name, files.flatMap((file) => (file.after === undefined ? [] : [{ path: file.diff.path, text: file.after }])))
  const { result, okExitCodes, parse } = await lint(request.run, root, workspace)
  const problem = runProblem(result, okExitCodes, scanner)
  if (result === undefined || problem !== undefined) return notRun(scanner.check, problem ?? scanner.install)
  try {
    return { findings: toRisks(parse(result.stdout), files), checksRun: [{ name: scanner.name, detail: scanner.detail }], notChecked: [] }
  } catch (error: unknown) {
    return notRun(scanner.check, `its output could not be read: ${messageOf(error)}`)
  }
}

const runRuff: LinterRun = async (run, root) => ({
  result: await run(RUFF_BINARY, ruffArgs(), root),
  okExitCodes: SUCCESS_ONLY,
  parse: (stdout) => parseRuffOutput(stdout, root),
})

const runOxlint: LinterRun = async (run, root, workspace) => {
  // Outside the scanned folder, so it cannot be linted or replaced by a file in the PR.
  const configPath = join(workspace, "oxlint-config.json")
  await writeFile(configPath, "{}")
  return {
    result: await run(OXLINT_BINARY, oxlintArgs(configPath), root),
    // oxlint exits 1 when a rule reports an error; its report is still complete.
    okExitCodes: OXLINT_OK_EXIT_CODES,
    parse: (stdout) => parseOxlintOutput(stdout, root),
  }
}

function runProblem(result: ProcessResult | undefined, okExitCodes: ReadonlySet<number>, scanner: ScannerIdentity): string | undefined {
  if (result === undefined) return scanner.install
  return okExitCodes.has(result.exitCode) ? undefined : `it failed: ${firstErrorLine(result)}`
}

/**
 * Scans all source at the head, not only the changed files, because the point is to catch new
 * code copied from something the PR did not touch.
 */
async function runJscpd(request: QualityScanRequest, candidates: readonly ScannedFile[], workspace: string): Promise<ScanOutcome<Risk>> {
  if (request.disabled?.has(JSCPD.id)) return notRun(JSCPD.check, TURNED_OFF_IN_SETTINGS)
  const reviewable = candidates.filter((file) => !isTestPath(file.diff.path) && hasAddedLines(file))
  if (reviewable.length === 0) return { findings: [], checksRun: [], notChecked: [] }
  const sources = (await listSourceFiles(request.repoDir, request.head)).filter(
    (path) => !isTestPath(path) && !request.isIgnored(path) && !CONFIG_LIKE_FILE.test(basename(path)),
  )
  if (sources.length > MAX_DUPLICATION_SOURCE_FILES) {
    return notRun(JSCPD.check, `the repository has more than ${MAX_DUPLICATION_SOURCE_FILES} source files`)
  }
  const root = await prepareScanRoot(workspace, JSCPD.name, [])
  await copySources(request, sources, root)
  const outputDir = join(workspace, "jscpd-output")
  const result = await request.run(JSCPD_BINARY, jscpdArgs(outputDir), root)
  const problem = runProblem(result, SUCCESS_ONLY, JSCPD)
  if (problem !== undefined) return notRun(JSCPD.check, problem)
  try {
    const clones = parseJscpdReport(await readFile(join(outputDir, JSCPD_REPORT_FILE), "utf8"))
    return { findings: cloneFindings(clones, root, reviewable), checksRun: [{ name: JSCPD.name, detail: JSCPD.detail }], notChecked: [] }
  } catch (error: unknown) {
    return notRun(JSCPD.check, `its report could not be read: ${messageOf(error)}`)
  }
}

async function copySources(request: QualityScanRequest, paths: readonly string[], root: string): Promise<void> {
  for (let start = 0; start < paths.length; start += SCAN_BATCH_FILES) {
    const batch = paths.slice(start, start + SCAN_BATCH_FILES)
    const blobs = await readBlobs(request.repoDir, batch.map((path) => ({ commit: request.head, path })))
    await writeScanFiles(
      root,
      batch.flatMap((path, index) => {
        const blob = blobs.at(index)
        return blob === undefined || blob.length > MAX_SOURCE_FILE_BYTES ? [] : [{ path, text: blob.toString("utf8") }]
      }),
    )
  }
}

async function prepareScanRoot(workspace: string, name: string, files: readonly { readonly path: string; readonly text: string }[]): Promise<string> {
  const root = join(workspace, name)
  await mkdir(root, { recursive: true })
  await writeScanFiles(root, files)
  return root
}

function hasAddedLines(file: ScannedFile): boolean {
  return addedLines(file.diff).length > 0
}

const DUPLICATE_RULE = {
  id: "jscpd.duplicate",
  category: RiskCategory.CodeQuality,
  severity: RiskSeverity.Medium,
  title: "Duplicated code",
  detail: "This new code repeats a block found elsewhere, so a later fix has to be made in both places. Consider reusing it. Reported by jscpd.",
}

function cloneFindings(clones: readonly Clone[], root: string, files: readonly ScannedFile[]): Risk[] {
  const added = new Map(files.map((file) => [file.diff.path, new Set(addedLines(file.diff).map((line) => line.line))]))
  return clones.flatMap(([first, second]) => {
    const a = { ...first, path: pathInScanRoot(root, first.path) }
    const b = { ...second, path: pathInScanRoot(root, second.path) }
    // When both copies are new, one finding is enough to prompt the reviewer.
    const [copy, original] = isMostlyAdded(a, added) ? [a, b] : [b, a]
    if (!isMostlyAdded(copy, added)) return []
    return [findingAt(DUPLICATE_RULE, copy.path, copy.start, `${copy.end - copy.start + 1} lines, also at ${original.path}:${original.start}`)]
  })
}

function isMostlyAdded(side: CloneSide, added: ReadonlyMap<string, ReadonlySet<number>>): boolean {
  const lines = added.get(side.path)
  if (lines === undefined) return false
  let count = 0
  for (let line = side.start; line <= side.end; line++) {
    if (lines.has(line)) count++
  }
  return count / (side.end - side.start + 1) >= MIN_ADDED_SHARE_OF_CLONE
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
