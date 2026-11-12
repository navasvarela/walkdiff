/**
 * Regenerates packages/engine/scanner-pins/semgrep-requirements.txt, the hash-pinned environment
 * Walkdiff installs Semgrep into, with the versions semgrep-overrides.txt puts in place of Semgrep's.
 *
 *   node scripts/lockSemgrep.ts
 *
 * Needs uv. Run it after changing SEMGREP_VERSION in installScanners.ts or the overrides.
 */
import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { SEMGREP_VERSION } from "../packages/engine/src/risk/scanners/installScanners.ts"

const PINS = join(import.meta.dirname, "..", "packages", "engine", "scanner-pins")
const LOCK = join(PINS, "semgrep-requirements.txt")
const OVERRIDES = join(PINS, "semgrep-overrides.txt")
// Semgrep's oldest supported Python, so the lock holds wheels that install there and on newer ones.
const OLDEST_PYTHON = "3.10"
// The lock runs to a few hundred kilobytes; this leaves ample room.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

// uv reads the requirement from standard input, which only the synchronous form can pass.
function compileLock(): string {
  return execFileSync(
    "uv",
    ["pip", "compile", "-", "--overrides", OVERRIDES, "--universal", "--generate-hashes", "--python-version", OLDEST_PYTHON, "--only-binary", ":all:", "--no-header", "--quiet"],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, input: `semgrep==${SEMGREP_VERSION}\n` },
  )
}

if (import.meta.main) {
  await writeFile(LOCK, compileLock())
  console.log(`Wrote ${LOCK} for Semgrep ${SEMGREP_VERSION}.`)
}
