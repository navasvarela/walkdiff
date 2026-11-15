import { RiskSeverity, isSecurityFinding, securityFindings } from "@walkdiff/review-model"
import type { ChangedFile, Risk, RiskAssessment, SkippedCheck } from "@walkdiff/review-model"
import { languageGaps } from "./languageCoverage.ts"
import { isIgnored, readWalkdiffConfig, WALKDIFF_CONFIG_PATH } from "../config/walkdiffConfig.ts"
import { readBlobs } from "../blobs.ts"
import type { ScannedFile } from "./scannedFile.ts"
import { readPipelineFiles } from "./pipelines/pipelineFiles.ts"
import type { PipelineFile } from "./pipelines/pipelineFiles.ts"
import { withoutRepeatedFindings } from "./repeatedFindings.ts"
import type { ScanOutcome } from "./scanners/scanWorkspace.ts"
import type { CheckContext, RiskAssessmentRequest } from "./checks/check.ts"
import { CHECKS, STEP_ORDER } from "./checks/registry.ts"

export type { RiskAssessmentRequest } from "./checks/check.ts"

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  [RiskSeverity.High]: 0,
  [RiskSeverity.Medium]: 1,
  [RiskSeverity.Low]: 2,
}

/** Runs every check in the registry over the change and rates its security level. */
export async function assessRisk(request: RiskAssessmentRequest): Promise<RiskAssessment> {
  const config = await readWalkdiffConfig(request.repoDir, request.base)
  const scanned: ScannedFile[] = request.files
    .map((file, index) => ({ diff: file.diff, noise: file.noise, after: request.headTexts.at(index) }))
    .filter((file) => !isIgnored(config, file.diff.path))
  const context: CheckContext = { request, config, scanned, pipelineFiles: once(() => readPipelineFiles(scanned, (paths) => readHeadTexts(request, paths))) }
  const outcomes = await runChecks(context)
  const findings = withoutRepeatedFindings(outcomes.flatMap((outcome) => outcome.findings)).sort(byImportance)
  return {
    securityLevel: securityLevelOf(findings),
    findings,
    checksRun: outcomes.flatMap((outcome) => outcome.checksRun),
    notChecked: [...outcomes.flatMap((outcome) => outcome.notChecked), ...coverageGaps(request.files, request.files.length - scanned.length)],
  }
}

/** Runs the checks step by step, as the progress display shows them, and returns their outcomes in registry order. */
async function runChecks(context: CheckContext): Promise<ScanOutcome<Risk>[]> {
  const outcomes = new Map<number, ScanOutcome<Risk>>()
  // A check on a step missing from STEP_ORDER still runs, after the others.
  const steps = new Set([...STEP_ORDER, ...CHECKS.map((check) => check.step)])
  for (const step of steps) {
    const inStep = CHECKS.flatMap((check, index) => (check.step === step ? [{ check, index }] : []))
    if (inStep.length === 0) continue
    context.request.reportStep(step)
    for (const { check, index } of inStep) outcomes.set(index, await check.run(context))
  }
  return CHECKS.map((_, index) => outcomes.get(index) ?? { findings: [], checksRun: [], notChecked: [] })
}

function once(read: () => Promise<readonly PipelineFile[]>): () => Promise<readonly PipelineFile[]> {
  let pending: Promise<readonly PipelineFile[]> | undefined
  return () => (pending ??= read())
}

async function readHeadTexts(request: RiskAssessmentRequest, paths: readonly string[]): Promise<(string | undefined)[]> {
  const blobs = await readBlobs(request.repoDir, paths.map((path) => ({ commit: request.head, path })))
  return blobs.map((blob) => blob?.toString("utf8"))
}

// Kept for sorting and colour. People read securitySummary instead, as a grade would claim too much.
function securityLevelOf(findings: readonly Risk[]): RiskSeverity {
  const security = securityFindings(findings)
  if (security.some((finding) => finding.severity === RiskSeverity.High)) return RiskSeverity.High
  if (security.some((finding) => finding.severity === RiskSeverity.Medium)) return RiskSeverity.Medium
  return RiskSeverity.Low
}

function coverageGaps(files: readonly ChangedFile[], ignoredCount: number): SkippedCheck[] {
  const gaps: SkippedCheck[] = []
  if (ignoredCount > 0) {
    gaps.push({ check: `Risk rules on ${ignoredCount} ${ignoredCount === 1 ? "file" : "files"}`, reason: `excluded by "ignore" in ${WALKDIFF_CONFIG_PATH}` })
  }
  return [...gaps, ...languageGaps(files.map((file) => file.diff.path))]
}

// Most severe first; at equal severity, security findings before review signals, then by place.
function byImportance(a: Risk, b: Risk): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    Number(isSecurityFinding(b)) - Number(isSecurityFinding(a)) ||
    (a.location?.path ?? "").localeCompare(b.location?.path ?? "") ||
    (a.location?.line ?? 0) - (b.location?.line ?? 0)
  )
}
