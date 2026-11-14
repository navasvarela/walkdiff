import { AnalysisStep, CheckId, RiskSeverity, isSecurityFinding, securityFindings } from "@walkdiff/review-model"
import type { ChangedFile, CheckRun, CommitSha, Risk, RiskAssessment, SkippedCheck, StepReporter } from "@walkdiff/review-model"
import { scanBreakingChanges } from "./breaking/scanBreakingChanges.ts"
import { scanDangerousApis } from "./dangerousApis.ts"
import { scanDependencies } from "./dependencies/scanDependencies.ts"
import { scanInfrastructure } from "./infrastructure.ts"
import { scanFunctionMetrics } from "./functionMetrics.ts"
import { languageGaps } from "./languageCoverage.ts"
import { reviewSignals } from "./reviewSignals.ts"
import { isIgnored, readWalkdiffConfig, WALKDIFF_CONFIG_PATH } from "../config/walkdiffConfig.ts"
import type { WalkdiffConfig } from "../config/walkdiffConfig.ts"
import { readBlobs } from "../blobs.ts"
import type { FileVersions } from "../syntax/compareUnits.ts"
import type { FunctionQuality } from "../syntax/functionQuality.ts"
import type { ScannedFile } from "./scannedFile.ts"
import { scanGitlabCi } from "./pipelines/gitlabCiRules.ts"
import { readPipelineFiles } from "./pipelines/pipelineFiles.ts"
import { withoutRepeatedFindings } from "./repeatedFindings.ts"
import { scanSecrets } from "./secrets.ts"
import { runCodeScanners } from "./scanners/runCodeScanners.ts"
import { runQualityScanners } from "./scanners/runQualityScanners.ts"
import { TURNED_OFF_IN_SETTINGS } from "./scanners/scanWorkspace.ts"
import type { ScanOutcome } from "./scanners/scanWorkspace.ts"
import type { ScannerProcessRunner } from "./scanners/scannerProcess.ts"
import { scanSensitivePaths } from "./sensitivePaths.ts"

export interface RiskAssessmentRequest {
  readonly repoDir: string
  readonly base: CommitSha
  readonly head: CommitSha
  readonly files: readonly ChangedFile[]
  /** Head text of each file in `files`, aligned by index; undefined where not read. */
  readonly headTexts: readonly (string | undefined)[]
  /** Every function at the head, measured against its previous version. */
  readonly functions: readonly FunctionQuality[]
  /** Both parsed versions of each analyzed file, for what the compared units don't keep. */
  readonly versions: readonly FileVersions[]
  readonly network: boolean
  readonly runScanner: ScannerProcessRunner
  readonly disabledChecks: ReadonlySet<CheckId>
  readonly reportStep: StepReporter
}

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  [RiskSeverity.High]: 0,
  [RiskSeverity.Medium]: 1,
  [RiskSeverity.Low]: 2,
}

const BUILT_IN_CHECK: CheckRun = { name: "Built-in rules", detail: "secrets, risky APIs, sensitive paths, GitLab CI, and Dockerfiles, Kubernetes and Terraform" }
const BREAKING_CHANGE_CHECK: CheckRun = { name: "Breaking changes", detail: "public APIs, database migrations, environment variables and config keys" }
const FUNCTION_METRICS_CHECK: CheckRun = { name: "Function metrics", detail: "complexity, nesting, length and parameters" }
const QUALITY_TURNED_OFF: SkippedCheck = { check: "Code quality checks", reason: `turned off in ${WALKDIFF_CONFIG_PATH}` }

/** Runs every risk check over the change and rates its security level. */
export async function assessRisk(request: RiskAssessmentRequest): Promise<RiskAssessment> {
  const config = await readWalkdiffConfig(request.repoDir, request.base)
  const scanned: ScannedFile[] = request.files
    .map((file, index) => ({ diff: file.diff, noise: file.noise, after: request.headTexts.at(index) }))
    .filter((file) => !isIgnored(config, file.diff.path))

  request.reportStep(AnalysisStep.CheckingDependencies)
  const dependencies = await scanDependencies({
    repoDir: request.repoDir,
    base: request.base,
    head: request.head,
    diffs: scanned.map((file) => file.diff),
    network: request.network,
    runScanner: request.runScanner,
    disabled: request.disabledChecks,
    privatePackages: config.dependencies.private,
    allowedLicenses: config.dependencies.allowedLicenses ?? undefined,
  })
  request.reportStep(AnalysisStep.ScanningCode)
  const pipelineFiles = await readPipelineFiles(scanned, (paths) => readHeadTexts(request, paths))
  const codeScan = await runCodeScanners({ files: scanned, semgrepRules: config.scanners.semgrep.rules, network: request.network, run: request.runScanner, disabled: request.disabledChecks, pipelineFiles })
  request.reportStep(AnalysisStep.CheckingQuality)
  const quality = config.quality.enabled ? await assessQuality(request, scanned, config) : { findings: [], checksRun: [], notChecked: [QUALITY_TURNED_OFF] }
  request.reportStep(AnalysisStep.CheckingBreakingChanges)
  const breaking = await scanBreakingChanges({
    repoDir: request.repoDir,
    base: request.base,
    head: request.head,
    files: request.files.filter((file) => !isIgnored(config, file.diff.path)),
    scanned,
    versions: request.versions,
  })
  const findings = withoutRepeatedFindings([
    ...scanSecrets(scanned),
    ...(await scanDangerousApis(scanned)),
    ...scanSensitivePaths(scanned, config),
    ...scanGitlabCi(scanned, pipelineFiles),
    ...scanInfrastructure(scanned),
    ...codeScan.findings,
    ...dependencies.findings,
    ...reviewSignals(request.files),
    ...breaking,
    ...quality.findings,
  ]).sort(byImportance)

  return {
    securityLevel: securityLevelOf(findings),
    findings,
    checksRun: [BUILT_IN_CHECK, BREAKING_CHANGE_CHECK, ...codeScan.checksRun, ...dependencies.checksRun, ...quality.checksRun],
    notChecked: [...codeScan.notChecked, ...dependencies.notChecked, ...quality.notChecked, ...coverageGaps(request.files, request.files.length - scanned.length)],
  }
}

async function assessQuality(request: RiskAssessmentRequest, scanned: readonly ScannedFile[], config: WalkdiffConfig): Promise<ScanOutcome<Risk>> {
  const scanners = await runQualityScanners({
    repoDir: request.repoDir,
    head: request.head,
    files: scanned,
    isIgnored: (path) => isIgnored(config, path),
    run: request.runScanner,
    disabled: request.disabledChecks,
  })
  if (request.disabledChecks.has(CheckId.FunctionMetrics)) {
    return { ...scanners, notChecked: [{ check: "Function measures", reason: TURNED_OFF_IN_SETTINGS }, ...scanners.notChecked] }
  }
  const functions = request.functions.filter((fn) => !isIgnored(config, fn.path))
  return { ...scanners, findings: [...scanFunctionMetrics(functions), ...scanners.findings], checksRun: [FUNCTION_METRICS_CHECK, ...scanners.checksRun] }
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
