/**
 * The steps of analyzing a PR, in the order they run. The app shows where an analysis is,
 * and the CLI prints each one, so a long run never looks stuck.
 */
export const AnalysisStep = {
  FetchingPullRequest: "fetchingPullRequest",
  FetchingCommits: "fetchingCommits",
  ReadingChanges: "readingChanges",
  TracingCallers: "tracingCallers",
  CheckingDependencies: "checkingDependencies",
  ScanningCode: "scanningCode",
  CheckingQuality: "checkingQuality",
  CheckingBreakingChanges: "checkingBreakingChanges",
  FindingCoverage: "findingCoverage",
  ReviewingWithAi: "reviewingWithAi",
} as const
export type AnalysisStep = (typeof AnalysisStep)[keyof typeof AnalysisStep]

export type StepReporter = (step: AnalysisStep) => void

const STEP_LABELS: Readonly<Record<AnalysisStep, string>> = {
  [AnalysisStep.FetchingPullRequest]: "Fetching the pull request",
  [AnalysisStep.FetchingCommits]: "Fetching its commits",
  [AnalysisStep.ReadingChanges]: "Reading the changed code",
  [AnalysisStep.TracingCallers]: "Finding code that uses it",
  [AnalysisStep.CheckingDependencies]: "Checking dependencies",
  [AnalysisStep.ScanningCode]: "Scanning for security problems",
  [AnalysisStep.CheckingQuality]: "Checking code quality",
  [AnalysisStep.CheckingBreakingChanges]: "Looking for breaking changes",
  [AnalysisStep.FindingCoverage]: "Looking for test coverage",
  [AnalysisStep.ReviewingWithAi]: "Waiting for the AI review",
}

const ORDER: readonly AnalysisStep[] = Object.values(AnalysisStep)

export interface StepPosition {
  /** Counting from 1. */
  readonly number: number
  readonly total: number
  readonly label: string
}

/** Where a step falls in an analysis, which has one step fewer without AI review. */
export function stepPosition(step: AnalysisStep, ai: boolean): StepPosition {
  const steps = ai ? ORDER : ORDER.filter((candidate) => candidate !== AnalysisStep.ReviewingWithAi)
  return { number: steps.indexOf(step) + 1, total: steps.length, label: STEP_LABELS[step] }
}

export function stepLabel(step: AnalysisStep): string {
  return STEP_LABELS[step]
}
