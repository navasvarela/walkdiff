import { AnalysisStep } from "@walkdiff/review-model"
import { isIgnored } from "../../config/walkdiffConfig.ts"
import { scanBreakingChanges } from "../breaking/scanBreakingChanges.ts"
import { scanDependencies } from "../dependencies/scanDependencies.ts"
import { reviewSignals } from "../reviewSignals.ts"
import { runCodeScanners } from "../scanners/runCodeScanners.ts"
import { scanSupplyChain } from "../supplyChain/scanSupplyChain.ts"
import { BUILT_IN_RULES_CHECK } from "./builtInRules.ts"
import type { Check } from "./check.ts"
import { BUILT_IN_RULES_NAME, creditedTo } from "./credit.ts"
import { QUALITY_CHECK } from "./quality.ts"

const BREAKING_CHANGES_RUN = { name: "Breaking changes", detail: "public APIs, database migrations, environment variables and config keys" }

const CODE_SCANNERS_CHECK: Check = {
  step: AnalysisStep.ScanningCode,
  run: async ({ request, scanned, config, pipelineFiles }) =>
    runCodeScanners({ files: scanned, semgrepRules: config.scanners.semgrep.rules, network: request.network, run: request.runScanner, disabled: request.disabledChecks, pipelineFiles: await pipelineFiles() }),
}

const DEPENDENCIES_CHECK: Check = {
  step: AnalysisStep.CheckingDependencies,
  run: ({ request, scanned, config }) =>
    scanDependencies({
      repoDir: request.repoDir,
      base: request.base,
      head: request.head,
      diffs: scanned.map((file) => file.diff),
      network: request.network,
      runScanner: request.runScanner,
      disabled: request.disabledChecks,
      privatePackages: config.dependencies.private,
      allowedLicenses: config.dependencies.allowedLicenses ?? undefined,
    }),
}

const SUPPLY_CHAIN_CHECK: Check = {
  step: AnalysisStep.CheckingDependencies,
  run: ({ request, scanned, config }) =>
    scanSupplyChain({ repoDir: request.repoDir, base: request.base, head: request.head, files: scanned, privatePackages: config.dependencies.private, network: request.network, disabled: request.disabledChecks }),
}

// Large PRs and code changed without its tests: where to look harder, read from every changed file.
// Reported among the built-in rules, which always run.
const REVIEW_SIGNALS_CHECK: Check = {
  step: AnalysisStep.ScanningCode,
  run: async ({ request }) => ({ findings: creditedTo(BUILT_IN_RULES_NAME, reviewSignals(request.files)), checksRun: [], notChecked: [] }),
}

const BREAKING_CHANGES_CHECK: Check = {
  step: AnalysisStep.CheckingBreakingChanges,
  run: async ({ request, scanned, config }) => ({
    findings: creditedTo(BREAKING_CHANGES_RUN.name, await scanBreakingChanges({
      repoDir: request.repoDir,
      base: request.base,
      head: request.head,
      files: request.files.filter((file) => !isIgnored(config, file.diff.path)),
      scanned,
      versions: request.versions,
    })),
    checksRun: [BREAKING_CHANGES_RUN],
    notChecked: [],
  }),
}

/**
 * Every check a review runs. Their findings, runs and gaps are reported in this order, which is
 * load-bearing: where two checks flag the same line, `withoutRepeatedFindings` keeps the first, so
 * the built-in rules come before the scanners that overlap them.
 */
export const CHECKS: readonly Check[] = [
  BUILT_IN_RULES_CHECK,
  CODE_SCANNERS_CHECK,
  DEPENDENCIES_CHECK,
  SUPPLY_CHAIN_CHECK,
  REVIEW_SIGNALS_CHECK,
  BREAKING_CHANGES_CHECK,
  QUALITY_CHECK,
]

/** The order checks run in, which the progress display follows. */
export const STEP_ORDER: readonly AnalysisStep[] = [AnalysisStep.CheckingDependencies, AnalysisStep.ScanningCode, AnalysisStep.CheckingQuality, AnalysisStep.CheckingBreakingChanges]
