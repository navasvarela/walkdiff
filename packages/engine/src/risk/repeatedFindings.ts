import { RiskCategory } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { RUFF_SECURITY_RULE_PREFIX } from "./scanners/ruffSecurity.ts"

/** Drops findings that only repeat another check's finding on the same line. */
export function withoutRepeatedFindings(findings: readonly Risk[]): Risk[] {
  return withoutRuffRepeats(withoutRepeatedSecrets(findings))
}

// Our rules, gitleaks and Semgrep can all flag one secret; one finding per line is enough.
// The built-in rules come first, so theirs is the one kept.
function withoutRepeatedSecrets(findings: readonly Risk[]): Risk[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    if (finding.category !== RiskCategory.Secret || finding.location === null) return true
    const key = `${finding.location.path}\0${finding.location.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Ruff's security rules overlap the built-in Python rules and Semgrep's defaults almost entirely
 * (`shell=True`, `yaml.load`, `pickle`, `eval`, `verify=False`), so where either flagged the line,
 * Ruff's finding is dropped. The others are kept because the built-in rules skip comments and
 * strings, and Semgrep's rules can trace data flow. Ruff's earn their place offline, when Semgrep
 * can't run, and on the rules the built-in ones don't have.
 */
function withoutRuffRepeats(findings: readonly Risk[]): Risk[] {
  const isRuff = (finding: Risk): boolean => finding.ruleId.startsWith(RUFF_SECURITY_RULE_PREFIX)
  const flaggedByOthers = new Set(findings.filter((finding) => !isRuff(finding) && isCodeFinding(finding)).flatMap((finding) => lineKey(finding) ?? []))
  return findings.filter((finding) => {
    const key = lineKey(finding)
    return !isRuff(finding) || key === undefined || !flaggedByOthers.has(key)
  })
}

function isCodeFinding(finding: Risk): boolean {
  return finding.category === RiskCategory.CodeScan || finding.category === RiskCategory.DangerousApi
}

function lineKey(finding: Risk): string | undefined {
  return finding.location === null || finding.location.line === null ? undefined : `${finding.location.path}\0${finding.location.line}`
}
