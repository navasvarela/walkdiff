import { AnalysisStep, FileChangeStatus, FileContentKind, SyntaxAnalysisStatus } from "@walkdiff/review-model"
import type { StepReporter } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, CheckId, CommitSha, ComparedUnit, FileDiff, FileNoise, RiskAssessment, SyntaxAnalysis } from "@walkdiff/review-model"
import { readBlobs } from "./blobs.ts"
import type { BlobRequest } from "./blobs.ts"
import { collectFileDiffs } from "./changedFiles.ts"
import { traceImpact } from "./impact/traceImpact.ts"
import { MAX_SOURCE_FILE_BYTES } from "./limits.ts"
import type { AnalyzedFile } from "./impact/traceImpact.ts"
import { classifyNoise, isNoiseByPath } from "./noise.ts"
import { assessRisk } from "./risk/assessRisk.ts"
import { runScannerProcess } from "./risk/scanners/scannerProcess.ts"
import type { ScannerProcessRunner } from "./risk/scanners/scannerProcess.ts"
import { compareUnits } from "./syntax/compareUnits.ts"
import type { FileVersions } from "./syntax/compareUnits.ts"
import { extractUnits } from "./syntax/definitions.ts"
import { functionQualities } from "./syntax/functionQuality.ts"
import { orderUnits, outlineOf, unitCalls } from "./syntax/fileStructure.ts"
import type { FileUnits } from "./syntax/definitions.ts"
import type { LanguageSpec } from "./syntax/languageSpec.ts"
import { languageSpecFor } from "./syntax/languages.ts"
import { withSyntaxTree } from "./syntax/parser.ts"

const NUL = 0

interface FileText {
  readonly before: string | undefined
  readonly after: string | undefined
}

type SyntaxPlan =
  | { readonly kind: "analyze"; readonly before: LanguageSpec | undefined; readonly after: LanguageSpec | undefined; readonly language: LanguageSpec }
  | { readonly kind: "settled"; readonly analysis: SyntaxAnalysis }

export interface AnalysisOptions {
  /** False keeps the analysis offline: no dependency lookups in the OSV database. */
  readonly network: boolean
  /** Runs third-party scanners; tests replace it. */
  readonly runScanner?: ScannerProcessRunner
  /** Checks the person turned off in their settings. */
  readonly disabledChecks?: readonly CheckId[]
  /** Told as each step starts, to show progress. */
  readonly reportStep?: StepReporter
}

export interface PullRequestAnalysis {
  readonly files: ChangedFile[]
  readonly risk: RiskAssessment
}

/** Diffs the two commits and runs every analysis layer over the changed files. */
export async function analyzeChangedFiles(
  repoDir: string,
  from: CommitSha,
  to: CommitSha,
  options: AnalysisOptions,
): Promise<PullRequestAnalysis> {
  const reportStep = options.reportStep ?? ignoreStep
  reportStep(AnalysisStep.ReadingChanges)
  const diffs = await collectFileDiffs(repoDir, from, to)
  const texts = await readFileTexts(repoDir, from, to, diffs)
  const noise = diffs.map((diff, index) => classifyNoise(diff.path, textAt(texts, index).after ?? textAt(texts, index).before))
  const plans = diffs.map((diff, index) => planSyntaxAnalysis(diff, textAt(texts, index), noise.at(index) ?? null))

  const versions = await Promise.all(
    diffs.map((diff, index) => extractVersions(diff, textAt(texts, index), plans.at(index))),
  )
  const analyzed = versions.filter((version): version is FileVersions => version !== undefined)
  const unitsByPath = compareUnits(analyzed)
  reportStep(AnalysisStep.TracingCallers)
  const impacts = await traceImpact(repoDir, to, analyzedFiles(diffs, plans, unitsByPath))
  const withImpact = (unit: ComparedUnit): ChangedUnit => ({ ...unit, impact: impacts.get(unit) ?? null })

  const files = diffs.map((diff, index) => ({
    diff,
    noise: noise.at(index) ?? null,
    syntax: syntaxAnalysis(plans.at(index), (unitsByPath.get(diff.path) ?? []).map(withImpact), versions.at(index)?.after),
  }))
  const risk = await assessRisk({
    repoDir,
    base: from,
    head: to,
    files,
    headTexts: texts.map((text) => text.after),
    functions: functionQualities(analyzed),
    versions: analyzed,
    network: options.network,
    runScanner: options.runScanner ?? runScannerProcess,
    disabledChecks: new Set(options.disabledChecks),
    reportStep,
  })
  return { files, risk }
}

function ignoreStep(): void {}

function analyzedFiles(
  diffs: readonly FileDiff[],
  plans: readonly SyntaxPlan[],
  unitsByPath: ReadonlyMap<string, ComparedUnit[]>,
): AnalyzedFile[] {
  return diffs.flatMap((diff, index) => {
    const plan = plans.at(index)
    if (plan?.kind !== "analyze") return []
    return [{ path: diff.path, spec: plan.language, units: unitsByPath.get(diff.path) ?? [], isNew: diff.status === FileChangeStatus.Added }]
  })
}

function planSyntaxAnalysis(diff: FileDiff, text: FileText, noise: FileNoise | null): SyntaxPlan {
  const after = diff.status === FileChangeStatus.Deleted ? undefined : languageSpecFor(diff.path)
  const before = diff.status === FileChangeStatus.Added ? undefined : languageSpecFor(previousPathOf(diff))
  const language = after ?? before
  if (language === undefined) {
    return { kind: "settled", analysis: { status: SyntaxAnalysisStatus.UnsupportedLanguage } }
  }
  const skipReason = reasonToSkip(diff, text, noise)
  if (skipReason !== undefined) {
    return { kind: "settled", analysis: { status: SyntaxAnalysisStatus.Skipped, reason: skipReason } }
  }
  return { kind: "analyze", before, after, language }
}

function reasonToSkip(diff: FileDiff, text: FileText, noise: FileNoise | null): string | undefined {
  if (noise !== null) return `${noise.kind} file`
  if (diff.content.kind === FileContentKind.Binary) return "binary file"
  // With one side missing, every unit would look added or removed.
  const beforeMissing = diff.status !== FileChangeStatus.Added && text.before === undefined
  const afterMissing = diff.status !== FileChangeStatus.Deleted && text.after === undefined
  if (beforeMissing || afterMissing) return "contents are not text or exceed 1 MB"
  return undefined
}

async function extractVersions(diff: FileDiff, text: FileText, plan: SyntaxPlan | undefined): Promise<FileVersions | undefined> {
  if (plan?.kind !== "analyze") {
    return undefined
  }
  return {
    path: diff.path,
    before: await parseUnits(plan.before, text.before),
    after: await parseUnits(plan.after, text.after),
  }
}

function parseUnits(spec: LanguageSpec | undefined, source: string | undefined): Promise<FileUnits | undefined> {
  if (spec === undefined || source === undefined) {
    return Promise.resolve(undefined)
  }
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

function syntaxAnalysis(plan: SyntaxPlan | undefined, units: ChangedUnit[], after: FileUnits | undefined): SyntaxAnalysis {
  if (plan === undefined) {
    return { status: SyntaxAnalysisStatus.Skipped, reason: "not analyzed" }
  }
  if (plan.kind === "settled") {
    return plan.analysis
  }
  const calls = unitCalls(after, units)
  return {
    status: SyntaxAnalysisStatus.Analyzed,
    language: plan.language.language,
    units: orderUnits(units, calls),
    outline: outlineOf(after),
    calls,
  }
}

/**
 * Reads both versions of every file that might be analyzed or checked for generated
 * markers. Lockfiles, vendored and binary files are left out: they are classified by
 * path or diff alone and can be very large.
 */
async function readFileTexts(repoDir: string, from: CommitSha, to: CommitSha, diffs: readonly FileDiff[]): Promise<FileText[]> {
  const requests: BlobRequest[] = []
  const request = (commit: CommitSha, path: string): number => requests.push({ commit, path }) - 1
  const slots = diffs.map((diff) => {
    if (diff.content.kind === FileContentKind.Binary || isNoiseByPath(diff.path)) {
      return { before: undefined, after: undefined }
    }
    return {
      before: diff.status === FileChangeStatus.Added ? undefined : request(from, previousPathOf(diff)),
      after: diff.status === FileChangeStatus.Deleted ? undefined : request(to, diff.path),
    }
  })
  const blobs = await readBlobs(repoDir, requests)
  const blobAt = (slot: number | undefined): Buffer | undefined => (slot === undefined ? undefined : blobs.at(slot))
  return slots.map((slot) => ({ before: decodeText(blobAt(slot.before)), after: decodeText(blobAt(slot.after)) }))
}

function decodeText(blob: Buffer | undefined): string | undefined {
  if (blob === undefined || blob.length > MAX_SOURCE_FILE_BYTES || blob.includes(NUL)) {
    return undefined
  }
  return blob.toString("utf8")
}

function previousPathOf(diff: FileDiff): string {
  return diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? diff.previousPath : diff.path
}

function textAt(texts: readonly FileText[], index: number): FileText {
  return texts.at(index) ?? { before: undefined, after: undefined }
}
