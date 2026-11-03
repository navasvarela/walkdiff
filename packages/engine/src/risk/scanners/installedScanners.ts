import { tmpdir } from "node:os"
import { OSV_SCANNER_BINARY } from "../dependencies/osvScanner.ts"
import { GITLEAKS_BINARY } from "./gitleaks.ts"
import { JSCPD_BINARY } from "./jscpd.ts"
import { OXLINT_BINARY } from "./oxlint.ts"
import { RUFF_BINARY } from "./ruff.ts"
import { runScannerProcess } from "./scannerProcess.ts"
import type { ScannerProcessRunner } from "./scannerProcess.ts"
import { SEMGREP_BINARY } from "./semgrep.ts"
import { ZIZMOR_BINARY } from "./zizmor.ts"

const SCANNER_BINARIES: readonly string[] = [SEMGREP_BINARY, GITLEAKS_BINARY, OSV_SCANNER_BINARY, RUFF_BINARY, ZIZMOR_BINARY, OXLINT_BINARY, JSCPD_BINARY]

export interface ScannerAvailability {
  readonly installed: readonly string[]
  readonly missing: readonly string[]
}

/** Which optional scanners this machine can run, so a user learns before opening a report. */
export async function findInstalledScanners(run: ScannerProcessRunner = runScannerProcess): Promise<ScannerAvailability> {
  const results = await Promise.all(SCANNER_BINARIES.map((binary) => run(binary, ["--version"], tmpdir())))
  return {
    installed: SCANNER_BINARIES.filter((_, index) => results.at(index) !== undefined),
    missing: SCANNER_BINARIES.filter((_, index) => results.at(index) === undefined),
  }
}
