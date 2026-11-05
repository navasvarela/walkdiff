import { matchesGlob } from "node:path"
import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import type { WalkdiffConfig } from "../config/walkdiffConfig.ts"
import { MIGRATION_PATH } from "./migrationFiles.ts"
import { findingAt } from "./scannedFile.ts"
import type { RuleDescription, ScannedFile } from "./scannedFile.ts"

interface PathRule extends RuleDescription {
  readonly pattern: RegExp
}

function pathRule(id: string, severity: RiskSeverity, pattern: RegExp, title: string, detail: string): PathRule {
  return { id, category: RiskCategory.SensitivePath, severity, pattern, title, detail }
}

// A segment boundary on both sides keeps `author.ts` from matching `auth`.
const SEGMENT = String.raw`(?:^|[/._-])`
const END = String.raw`(?:$|[/._-])`

const BUILT_IN_RULES: readonly PathRule[] = [
  pathRule("path.walkdiff-config", RiskSeverity.Medium, /^\.(walkdiff|lens)\.json$/, "Review rules changed", "This file sets what the risk checks ignore and whether AI review may run. Changes take effect after merge; check they do not hide anything."),
  pathRule("path.ci-pipeline", RiskSeverity.Medium, /^\.github\/workflows\/|^\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$|^\.circleci\//, "CI pipeline", "Pipelines run with repository secrets and deploy rights; check what new steps can reach."),
  pathRule("path.secrets-config", RiskSeverity.Medium, /(^|\/)\.env(\.[\w-]+)?$|(^|\/)secrets?\.(ya?ml|json|toml)$/, "Secrets configuration", "Files of this kind often hold credentials; check nothing real is committed."),
  pathRule("path.auth", RiskSeverity.Medium, new RegExp(`${SEGMENT}(auth|authn|authz|login|session|sessions|oauth|sso|permissions?|acl|rbac|access[_-]?control)${END}`, "i"), "Authentication or authorization", "A mistake here can let users act as someone else or reach data they should not."),
  pathRule("path.crypto", RiskSeverity.Medium, new RegExp(`${SEGMENT}(crypto|cryptography|encrypt|encryption|cipher|signing|signature|jwt|keys?tore)${END}`, "i"), "Cryptography", "Subtle errors in cryptographic code rarely show in tests; check algorithms, key handling and randomness."),
  pathRule("path.payments", RiskSeverity.Medium, new RegExp(`${SEGMENT}(payments?|billing|invoices?|stripe)${END}`, "i"), "Payments or billing", "Errors here cost money directly; check amounts, currencies and idempotency."),
  pathRule("path.migration", RiskSeverity.Medium, MIGRATION_PATH, "Database migration", "Migrations change production data and can be slow or irreversible; check locking and rollback."),
  pathRule("path.infrastructure", RiskSeverity.Low, /\.tf$|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*\.ya?ml$|(^|\/)(k8s|kubernetes|helm|charts)\//, "Infrastructure or deployment", "Changes the environment the code runs in: exposure, permissions and resource limits."),
]

/** One finding per file: team rules from the config first, then the first built-in rule that matches. */
export function scanSensitivePaths(files: readonly ScannedFile[], config: WalkdiffConfig): Risk[] {
  return files.flatMap((file) => {
    const path = file.diff.path
    const configured = config.riskPaths.find((entry) => matchesGlob(path, entry.pattern))
    if (configured !== undefined) {
      const teamRule: RuleDescription = {
        id: `config.${configured.pattern}`,
        category: RiskCategory.SensitivePath,
        severity: configured.severity,
        title: "Sensitive area (team rule)",
        detail: configured.reason,
      }
      return [findingAt(teamRule, path, null, null)]
    }
    const builtIn = BUILT_IN_RULES.find((candidate) => candidate.pattern.test(path))
    return builtIn === undefined ? [] : [findingAt(builtIn, path, null, null)]
  })
}
