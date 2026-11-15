import { AnalysisStep, CheckId } from "@walkdiff/review-model"
import type { CheckRun, Risk, SkippedCheck } from "@walkdiff/review-model"
import { isIgnored, WALKDIFF_CONFIG_PATH } from "../../config/walkdiffConfig.ts"
import { scanErrorHandling } from "../errorHandling.ts"
import { scanFunctionMetrics } from "../functionMetrics.ts"
import { runQualityScanners } from "../scanners/runQualityScanners.ts"
import { TURNED_OFF_IN_SETTINGS } from "../scanners/scanWorkspace.ts"
import type { ScanOutcome } from "../scanners/scanWorkspace.ts"
import type { Check, CheckContext } from "./check.ts"

const FUNCTION_METRICS_CHECK: CheckRun = { name: "Function metrics", detail: "complexity, nesting, length and parameters" }
const ERROR_HANDLING_CHECK: CheckRun = { name: "Error handling", detail: "swallowed errors, catch-alls, panics and discarded results in added code" }
const QUALITY_TURNED_OFF: SkippedCheck = { check: "Code quality checks", reason: `turned off in ${WALKDIFF_CONFIG_PATH}` }
const FUNCTION_METRICS_OFF: SkippedCheck = { check: "Function measures", reason: TURNED_OFF_IN_SETTINGS }

/**
 * Code quality, as opposed to security: the linters and duplicate detection, error handling, and
 * function measures. A team can turn all of it off in `.walkdiff.json`.
 */
export const QUALITY_CHECK: Check = {
  step: AnalysisStep.CheckingQuality,
  run: async (context) => (context.config.quality.enabled ? assessQuality(context) : { findings: [], checksRun: [], notChecked: [QUALITY_TURNED_OFF] }),
}

async function assessQuality({ request, scanned, config }: CheckContext): Promise<ScanOutcome<Risk>> {
  const scanners = await runQualityScanners({
    repoDir: request.repoDir,
    head: request.head,
    files: scanned,
    isIgnored: (path) => isIgnored(config, path),
    run: request.runScanner,
    disabled: request.disabledChecks,
  })
  const errorHandling = await scanErrorHandling(scanned)
  if (request.disabledChecks.has(CheckId.FunctionMetrics)) {
    return {
      findings: [...errorHandling, ...scanners.findings],
      checksRun: [ERROR_HANDLING_CHECK, ...scanners.checksRun],
      notChecked: [FUNCTION_METRICS_OFF, ...scanners.notChecked],
    }
  }
  const functions = request.functions.filter((fn) => !isIgnored(config, fn.path))
  return {
    ...scanners,
    findings: [...scanFunctionMetrics(functions), ...errorHandling, ...scanners.findings],
    checksRun: [FUNCTION_METRICS_CHECK, ERROR_HANDLING_CHECK, ...scanners.checksRun],
  }
}
