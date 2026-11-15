import { AnalysisStep } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { scanAttackSurface } from "../attackSurface.ts"
import { scanDangerousApis } from "../dangerousApis.ts"
import { scanInfrastructure } from "../infrastructure.ts"
import { scanGitlabCi } from "../pipelines/gitlabCiRules.ts"
import { scanSecrets } from "../secrets.ts"
import { scanSensitivePaths } from "../sensitivePaths.ts"
import type { Check, CheckContext } from "./check.ts"

/** A rule set that ships with Walkdiff and needs no scanner installed, so it always runs. */
interface BuiltInRule {
  /** What it looks for, as the "Built-in rules" entry lists it: "new endpoints". */
  readonly covers: string
  find(context: CheckContext): Risk[] | Promise<Risk[]>
}

// Secrets come first: when gitleaks or Semgrep flag the same line, the built-in finding is the one
// kept (see repeatedFindings.ts).
const RULES: readonly BuiltInRule[] = [
  { covers: "secrets", find: ({ scanned }) => scanSecrets(scanned) },
  { covers: "risky APIs", find: ({ scanned }) => scanDangerousApis(scanned) },
  { covers: "new endpoints", find: ({ scanned }) => scanAttackSurface(scanned) },
  { covers: "sensitive paths", find: ({ scanned, config }) => scanSensitivePaths(scanned, config) },
  { covers: "GitLab CI", find: async ({ scanned, pipelineFiles }) => scanGitlabCi(scanned, await pipelineFiles()) },
  { covers: "infrastructure code", find: ({ scanned }) => scanInfrastructure(scanned) },
]

export const BUILT_IN_RULES_CHECK: Check = {
  step: AnalysisStep.ScanningCode,
  run: async (context) => {
    const findings: Risk[] = []
    for (const rule of RULES) findings.push(...(await rule.find(context)))
    return { findings, checksRun: [{ name: "Built-in rules", detail: inWords(RULES.map((rule) => rule.covers)) }], notChecked: [] }
  },
}

/** `["a", "b", "c"]` → "a, b and c". */
function inWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`
}
