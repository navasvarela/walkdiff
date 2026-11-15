import { ModificationWeight, RiskCategory, SyntaxAnalysisStatus, UnitChangeKind, UnitImpactStatus, UnitKind } from "./schema.ts"
import type { ChangedFile, ChangedUnit, CheckRun, Reference, Risk, UnitChange } from "./schema.ts"

export function changedUnitsOf(file: ChangedFile): readonly ChangedUnit[] {
  return file.syntax.status === SyntaxAnalysisStatus.Analyzed ? file.syntax.units : []
}

/**
 * False for formatting, comments, renames and unedited moves, which leave behaviour as it was.
 * An edited move counts once, where the unit arrived: the side it left has nothing new to read.
 */
export function isBehaviourChange(change: UnitChange): boolean {
  switch (change.kind) {
    case UnitChangeKind.Added:
    case UnitChangeKind.Removed:
      return true
    case UnitChangeKind.Modified:
      return change.weight === ModificationWeight.Semantic
    case UnitChangeKind.MovedIn:
      return change.edited
    case UnitChangeKind.Renamed:
    case UnitChangeKind.MovedOut:
      return false
  }
}

const TEST_KINDS: ReadonlySet<UnitKind> = new Set([UnitKind.TestSuite, UnitKind.Test, UnitKind.TestHook])

/** Suites, tests and their setup, recognised from the test framework's own calls. */
export function isTestKind(kind: UnitKind): boolean {
  return TEST_KINDS.has(kind)
}

/** Places using this unit that the PR did not change. */
export function untouchedReferences(unit: ChangedUnit): readonly Reference[] {
  if (unit.impact?.status !== UnitImpactStatus.Traced) return []
  return unit.impact.references.filter((reference) => !reference.touchedByPullRequest)
}

/** Names the checks in a sentence, so "nothing found" says what looked. */
export function namesOfChecks(checks: readonly CheckRun[]): string {
  const names = checks.map((check) => check.name)
  const last = names.at(-1) ?? ""
  return names.length < 2 ? last : `${names.slice(0, -1).join(", ")} and ${last}`
}

/**
 * Categories that count as security findings; the others are review signals. Breaking changes
 * stay out: they can take down a deployment, but they expose nothing to an attacker, and security
 * wording raised by a renamed column would teach people to discount it.
 */
const SECURITY_CATEGORIES: ReadonlySet<RiskCategory> = new Set([
  RiskCategory.Secret,
  RiskCategory.DangerousApi,
  RiskCategory.SensitivePath,
  RiskCategory.Dependency,
  RiskCategory.Vulnerability,
  RiskCategory.CodeScan,
  RiskCategory.AttackSurface,
  RiskCategory.Infrastructure,
  RiskCategory.SupplyChain,
])

export function isSecurityFinding(finding: Risk): boolean {
  return SECURITY_CATEGORIES.has(finding.category)
}

export function securityFindings(findings: readonly Risk[]): Risk[] {
  return findings.filter(isSecurityFinding)
}

/**
 * States what was found rather than rating the change. These checks match patterns and secrets
 * on added lines, so a grade such as "low" would claim more than they can know.
 */
export function securitySummary(findings: readonly Risk[]): string {
  const count = securityFindings(findings).length
  if (count === 0) return "No security findings"
  return count === 1 ? "1 security finding" : `${count} security findings`
}

export const SECURITY_SCAN_LIMITS = "These checks look for known patterns and secrets on the lines this PR adds, so this isn't a security audit."

/**
 * Marks text as code inside a finding's title, as `name`. Names come from the PR, so a backtick
 * in one is removed: it must not be able to end the span and be read as anything else.
 */
export function codeSpan(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, "")}\``
}
