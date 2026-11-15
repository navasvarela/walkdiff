import type { AnalysisStep, ChangedFile, CheckId, CommitSha, Risk, StepReporter } from "@walkdiff/review-model"
import type { WalkdiffConfig } from "../../config/walkdiffConfig.ts"
import type { FileVersions } from "../../syntax/compareUnits.ts"
import type { FunctionQuality } from "../../syntax/functionQuality.ts"
import type { PipelineFile } from "../pipelines/pipelineFiles.ts"
import type { ScannedFile } from "../scannedFile.ts"
import type { ScannerProcessRunner } from "../scanners/scannerProcess.ts"
import type { ScanOutcome } from "../scanners/scanWorkspace.ts"

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

/** What every check is given: the review request, the team's config, and the files to read. */
export interface CheckContext {
  readonly request: RiskAssessmentRequest
  /** `.walkdiff.json` at the merge base, so a PR can't change the rules it's checked by. */
  readonly config: WalkdiffConfig
  /** Changed files the config doesn't ignore, with their head text where it was read. */
  readonly scanned: readonly ScannedFile[]
  /** CI files at the head when the change touches one, read once for every check that wants them. */
  readonly pipelineFiles: () => Promise<readonly PipelineFile[]>
}

/**
 * One thing the review checks. It reports its findings, which checks it ran and which it couldn't,
 * with why. Adding a check means writing one and listing it in `registry.ts`; its findings then
 * reach the report, and its runs and gaps the Risks tab's "Checked" and "Not checked" lists.
 */
export interface Check {
  /** What the progress display says while it runs. Checks run in the order of their steps. */
  readonly step: AnalysisStep
  run(context: CheckContext): Promise<ScanOutcome<Risk>>
}
