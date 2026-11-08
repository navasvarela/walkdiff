import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import { isTestPath } from "../testCode.ts"
import { readRuffViolations, ruffCheckArgs, ruffDetail } from "./ruff.ts"
import type { ScannerFinding } from "./scannerFinding.ts"

export const RUFF_SECURITY_RULE_PREFIX = "ruff-security."

/**
 * Ruff's port of Bandit (its `S` rules), limited to the ones that point at a real weakness. Left
 * out because they fire on ordinary code far more often than on a problem: `assert` (S101),
 * binding to all interfaces (S104), password-like strings (S105-S107, which gitleaks and the
 * built-in secret rules cover better), `/tmp` paths (S108), swallowed exceptions (S110, S112),
 * missing request timeouts (S113), `random` (S311), XML parsers (S313-S320, safe against entity
 * expansion attacks since Python 3.7.1), every `urlopen` (S310), paramiko's `exec_command` (S601),
 * any subprocess call (S603, S606, S607), suspicious imports (S4xx), and any use of Mako (S702).
 *
 * None is rated high: Ruff matches a pattern in one file without tracing where the data came
 * from, so it can't tell an attacker-controlled argument from a constant. Semgrep's taint rules
 * can, which is why its finding wins when both report the same line.
 */
const RULE_SEVERITIES: ReadonlyMap<string, RiskSeverity> = new Map([
  ["S102", RiskSeverity.Medium], // exec
  ["S103", RiskSeverity.Low], // permissive file mode
  ["S201", RiskSeverity.Medium], // Flask debug mode
  ["S202", RiskSeverity.Medium], // tarfile extractall without a filter
  ["S301", RiskSeverity.Medium], // pickle
  ["S302", RiskSeverity.Medium], // marshal
  ["S303", RiskSeverity.Low], // MD5 or SHA-1 through cryptography
  ["S304", RiskSeverity.Low], // weak cipher
  ["S305", RiskSeverity.Low], // ECB mode
  ["S306", RiskSeverity.Low], // tempfile.mktemp
  ["S307", RiskSeverity.Medium], // eval
  ["S308", RiskSeverity.Low], // Django mark_safe
  ["S323", RiskSeverity.Medium], // unverified SSL context
  ["S324", RiskSeverity.Low], // MD5 or SHA-1 through hashlib
  ["S501", RiskSeverity.Medium], // requests with verify=False
  ["S502", RiskSeverity.Medium], // SSLv2, SSLv3 or TLS 1.0
  ["S503", RiskSeverity.Medium], // insecure SSL defaults
  ["S505", RiskSeverity.Low], // short RSA, DSA or EC key
  ["S506", RiskSeverity.Medium], // yaml.load without a safe loader
  ["S507", RiskSeverity.Medium], // paramiko accepting unknown host keys
  ["S508", RiskSeverity.Low], // SNMP v1 or v2
  ["S509", RiskSeverity.Low], // SNMP without encryption
  ["S602", RiskSeverity.Medium], // subprocess with shell=True
  ["S604", RiskSeverity.Medium], // any call with shell=True
  ["S605", RiskSeverity.Medium], // os.system and friends
  ["S608", RiskSeverity.Medium], // SQL built from strings
  ["S609", RiskSeverity.Medium], // wildcard in a shell command
  ["S610", RiskSeverity.Medium], // Django extra()
  ["S611", RiskSeverity.Medium], // Django RawSQL
  ["S612", RiskSeverity.Medium], // logging.config.listen
  ["S701", RiskSeverity.Medium], // Jinja2 with autoescape off
  ["S704", RiskSeverity.Medium], // Markup from untrusted input
])

export function ruffSecurityArgs(): string[] {
  return ruffCheckArgs([...RULE_SEVERITIES.keys()])
}

/** Test code doesn't run in production, and loading fixtures with pickle or YAML is routine there. */
export function parseRuffSecurityOutput(stdout: string, root: string): ScannerFinding[] {
  return readRuffViolations(stdout, root).flatMap((violation) => {
    const severity = RULE_SEVERITIES.get(violation.code)
    if (severity === undefined || isTestPath(violation.path)) return []
    return [{
      ruleId: `${RUFF_SECURITY_RULE_PREFIX}${violation.code}`,
      category: RiskCategory.CodeScan,
      severity,
      title: violation.title,
      detail: ruffDetail(violation),
      path: violation.path,
      line: violation.line,
      endLine: violation.endLine,
      showLine: true,
    }]
  })
}
