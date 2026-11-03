import { RiskCategory } from "./schema.ts"
import type { Risk, RiskAssessment } from "./schema.ts"

export const CheckOutcome = { Clean: "clean", Issues: "issues", NotRun: "notRun" } as const
export type CheckOutcome = (typeof CheckOutcome)[keyof typeof CheckOutcome]

export type CheckRow =
  | { readonly outcome: typeof CheckOutcome.Clean; readonly name: string; readonly detail: string }
  | { readonly outcome: typeof CheckOutcome.Issues; readonly name: string; readonly detail: string; readonly issues: number }
  | { readonly outcome: typeof CheckOutcome.NotRun; readonly name: string; readonly detail: string }

export interface CheckTotals {
  readonly clean: number
  readonly withIssues: number
  readonly notRun: number
}

const BUILT_IN_CHECK = "Built-in rules"
const OSV_CHECKS: readonly string[] = ["OSV database", "osv-scanner"]
const CHECK_BY_RULE_PREFIX: ReadonlyMap<string, string> = new Map([
  ["semgrep.", "Semgrep"],
  ["gitleaks.", "gitleaks"],
  ["oxlint.", "oxlint"],
  ["ruff.", "Ruff"],
  ["jscpd.", "jscpd"],
  ["quality.", "Function metrics"],
  ["breaking.", "Breaking changes"],
  ["trust.", "Dependency trust"],
  ["zizmor.", "zizmor"],
])

/**
 * Which check raised a finding. Everything falls through to the built-in rules, so the counts per
 * check always add up to the total a reviewer sees in the findings list.
 */
function checkThatFound(finding: Risk, ran: ReadonlySet<string>): string {
  const byRule = [...CHECK_BY_RULE_PREFIX].find(([prefix]) => finding.ruleId.startsWith(prefix))?.[1]
  // Both OSV checks report the same kind of finding with nothing to tell them apart; they're close enough to share a row.
  const named = finding.category === RiskCategory.Vulnerability ? OSV_CHECKS.find((check) => ran.has(check)) : byRule
  return named !== undefined && ran.has(named) ? named : BUILT_IN_CHECK
}

/** One row per check: what it looked for and what came of it, with anything that found issues first. */
export function summarizeChecks(risk: RiskAssessment): CheckRow[] {
  const ran = new Set(risk.checksRun.map((check) => check.name))
  const issues = new Map<string, number>()
  for (const finding of risk.findings) {
    const check = checkThatFound(finding, ran)
    issues.set(check, (issues.get(check) ?? 0) + 1)
  }
  const ranRows = risk.checksRun.map((check): CheckRow => {
    const count = issues.get(check.name) ?? 0
    return count === 0 ? { outcome: CheckOutcome.Clean, name: check.name, detail: check.detail } : { outcome: CheckOutcome.Issues, name: check.name, detail: check.detail, issues: count }
  })
  return [
    ...ranRows.filter((row) => row.outcome === CheckOutcome.Issues),
    ...risk.notChecked.map((skipped): CheckRow => ({ outcome: CheckOutcome.NotRun, name: skipped.check, detail: skipped.reason })),
    ...ranRows.filter((row) => row.outcome === CheckOutcome.Clean),
  ]
}

export function totalsOf(rows: readonly CheckRow[]): CheckTotals {
  const count = (outcome: CheckOutcome): number => rows.filter((row) => row.outcome === outcome).length
  return { clean: count(CheckOutcome.Clean), withIssues: count(CheckOutcome.Issues), notRun: count(CheckOutcome.NotRun) }
}
