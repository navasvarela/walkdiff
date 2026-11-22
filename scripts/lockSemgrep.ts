/**
 * Regenerates packages/engine/scanner-pins/semgrep-requirements.txt, the hash-pinned environment
 * Walkdiff installs Semgrep into, with the versions semgrep-overrides.txt puts in place of Semgrep's.
 *
 *   node scripts/lockSemgrep.ts
 *
 * Needs uv. Run it after changing SEMGREP_VERSION in installScanners.ts or the overrides. Packages
 * released in the last week are left out, so the version Semgrep pins can't be newer than that.
 */
import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { SEMGREP_MIN_PYTHON, SEMGREP_VERSION } from "../packages/engine/src/risk/scanners/installScanners.ts"

const PINS = join(import.meta.dirname, "..", "packages", "engine", "scanner-pins")
const LOCK = join(PINS, "semgrep-requirements.txt")
const OVERRIDES = join(PINS, "semgrep-overrides.txt")
// The oldest Python the environment installs on, so the lock holds wheels that install there and on newer ones.
const OLDEST_PYTHON = `${SEMGREP_MIN_PYTHON.major}.${SEMGREP_MIN_PYTHON.minor}`
// As Dependabot does for npm (.github/dependabot.yml): a compromised release is usually found and
// pulled within days, so the lock only takes versions released at least this long ago.
const COOLDOWN_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
// The lock runs to a few hundred kilobytes; this leaves ample room.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

// uv reads the requirement from standard input, which only the synchronous form can pass.
function compileLock(now: Date): string {
  const cutoff = new Date(now.getTime() - COOLDOWN_DAYS * DAY_MS).toISOString()
  return execFileSync(
    "uv",
    ["pip", "compile", "-", "--overrides", OVERRIDES, "--universal", "--generate-hashes", "--python-version", OLDEST_PYTHON, "--only-binary", ":all:", "--exclude-newer", cutoff, "--no-header", "--quiet"],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, input: `semgrep==${SEMGREP_VERSION}\n` },
  )
}

if (import.meta.main) {
  await writeFile(LOCK, compileLock(new Date()))
  console.log(`Wrote ${LOCK} for Semgrep ${SEMGREP_VERSION}.`)
}
