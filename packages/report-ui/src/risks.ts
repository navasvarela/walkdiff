import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"

export const SEVERITY_LABELS: Readonly<Record<RiskSeverity, string>> = {
  [RiskSeverity.High]: "High",
  [RiskSeverity.Medium]: "Medium",
  [RiskSeverity.Low]: "Low",
}

export const CATEGORY_LABELS: Readonly<Record<RiskCategory, string>> = {
  [RiskCategory.Secret]: "Possible secret",
  [RiskCategory.DangerousApi]: "Risky API",
  [RiskCategory.SensitivePath]: "Sensitive area",
  [RiskCategory.Dependency]: "Dependency",
  [RiskCategory.Vulnerability]: "Known vulnerability",
  [RiskCategory.CodeScan]: "Code scan",
  [RiskCategory.CodeQuality]: "Code quality",
  [RiskCategory.Tests]: "Tests",
  [RiskCategory.Size]: "Size",
  [RiskCategory.BrokenReference]: "Broken reference",
  [RiskCategory.License]: "Licence",
  [RiskCategory.BreakingChange]: "Breaking change",
  [RiskCategory.AttackSurface]: "Attack surface",
  [RiskCategory.Infrastructure]: "Infrastructure",
}

/** Findings from one rule, so twenty `unsafe` blocks read as one item with twenty places. */
export interface RiskGroup {
  readonly ruleId: string
  readonly title: string
  readonly findings: readonly Risk[]
}

/** Groups findings by rule and title, keeping the incoming order (most severe first). */
export function groupByRule(findings: readonly Risk[]): RiskGroup[] {
  const groups = new Map<string, Risk[]>()
  for (const finding of findings) {
    const key = `${finding.ruleId}\0${finding.title}`
    groups.set(key, [...(groups.get(key) ?? []), finding])
  }
  return [...groups.values()].flatMap((group) => {
    const first = group.at(0)
    return first === undefined ? [] : [{ ruleId: first.ruleId, title: first.title, findings: group }]
  })
}

export function findingsInFile(findings: readonly Risk[], path: string): Risk[] {
  return findings.filter((finding) => finding.location?.path === path)
}

/** The worst severity among findings, for a file's badge; undefined when there are none. */
export function worstSeverity(findings: readonly Risk[]): RiskSeverity | undefined {
  if (findings.some((finding) => finding.severity === RiskSeverity.High)) return RiskSeverity.High
  if (findings.some((finding) => finding.severity === RiskSeverity.Medium)) return RiskSeverity.Medium
  return findings.length > 0 ? RiskSeverity.Low : undefined
}
