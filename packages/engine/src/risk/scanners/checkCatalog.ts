import { tmpdir } from "node:os"
import { CheckId } from "@walkdiff/review-model"
import type { CheckStatus } from "@walkdiff/review-model"
import { OSV_SCANNER_BINARY } from "../dependencies/osvScanner.ts"
import { GITLEAKS_BINARY } from "./gitleaks.ts"
import { JSCPD_BINARY } from "./jscpd.ts"
import { OXLINT_BINARY } from "./oxlint.ts"
import { RUFF_BINARY } from "./ruff.ts"
import { runScannerProcess } from "./scannerProcess.ts"
import type { ScannerProcessRunner } from "./scannerProcess.ts"
import { SEMGREP_BINARY } from "./semgrep.ts"
import { ZIZMOR_BINARY } from "./zizmor.ts"

interface CheckDescription {
  readonly id: CheckId
  readonly name: string
  readonly purpose: string
  readonly binary: string | null
  readonly install: string | null
  readonly sends: string | null
}

const OSV_DESTINATION = "Names and versions of changed dependencies, including private package names, to OSV"

const CHECKS: readonly CheckDescription[] = [
  { id: CheckId.Gitleaks, name: "gitleaks", purpose: "Finds secrets in added code", binary: GITLEAKS_BINARY, install: "pnpm install", sends: null },
  { id: CheckId.Semgrep, name: "Semgrep", purpose: "Finds risky code patterns", binary: SEMGREP_BINARY, install: "pnpm install, with Python 3.10 or later", sends: "Downloads rules from the Semgrep registry; your code isn't uploaded" },
  { id: CheckId.OsvDatabase, name: "OSV database", purpose: "Finds known vulnerabilities in new dependency versions", binary: null, install: null, sends: OSV_DESTINATION },
  { id: CheckId.OsvScanner, name: "osv-scanner", purpose: "Finds known vulnerabilities in pnpm, yarn and bun lockfiles", binary: OSV_SCANNER_BINARY, install: "pnpm install", sends: OSV_DESTINATION },
  { id: CheckId.Zizmor, name: "zizmor", purpose: "Finds security problems in GitHub Actions workflows", binary: ZIZMOR_BINARY, install: "pnpm install", sends: null },
  { id: CheckId.DependencyTrust, name: "Dependency trust", purpose: "Flags new packages that are malicious, missing from the registry, very new or lookalikes", binary: null, install: null, sends: "Names of new direct dependencies, except those you list as private, to OSV, npm, PyPI and crates.io" },
  { id: CheckId.FunctionMetrics, name: "Function measures", purpose: "Flags complex, long or deeply nested functions", binary: null, install: null, sends: null },
  { id: CheckId.Ruff, name: "Ruff", purpose: "Finds likely bugs in Python", binary: RUFF_BINARY, install: "pnpm install", sends: null },
  { id: CheckId.Oxlint, name: "oxlint", purpose: "Finds likely bugs in TypeScript and JavaScript", binary: OXLINT_BINARY, install: "pnpm install", sends: null },
  { id: CheckId.Jscpd, name: "jscpd", purpose: "Finds new code copied from elsewhere in the repository", binary: JSCPD_BINARY, install: "pnpm install", sends: null },
]

/** Every optional check, and whether this machine can run it right now. */
export async function describeChecks(run: ScannerProcessRunner = runScannerProcess): Promise<CheckStatus[]> {
  return Promise.all(
    CHECKS.map(async ({ id, name, purpose, binary, install, sends }) => ({
      id,
      name,
      purpose,
      installed: binary === null ? null : (await run(binary, ["--version"], tmpdir())) !== undefined,
      install,
      sends,
    })),
  )
}
