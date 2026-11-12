/**
 * Regenerates packages/engine/scanner-pins/semgrep-requirements.txt, the hash-pinned environment
 * Walkdiff installs Semgrep into, without the packages semgrep-overrides.txt leaves out.
 *
 *   node scripts/lockSemgrep.ts
 *
 * Needs uv. Run it after changing SEMGREP_VERSION in installScanners.ts.
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
const NEVER_MARKER = "sys_platform == 'never'"
const PACKAGE_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)==/
// The lock runs to a few hundred kilobytes; this leaves ample room.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Removes the packages uv kept behind a never-true marker, and the annotations that name them.
 * pip would skip them anyway, but listed, they'd still be watched for vulnerabilities they can't have.
 */
export function withoutExcludedPackages(lock: string): string {
  const blocks = lock.trimEnd().split(/\n(?=[A-Za-z0-9])/)
  const excluded = new Set(blocks.filter((block) => firstLine(block).includes(NEVER_MARKER)).map(packageName))
  const kept = blocks.filter((block) => !excluded.has(packageName(block)))
  return `${kept.map((block) => withoutAnnotationsOf(block, excluded)).join("\n")}\n`
}

function firstLine(block: string): string {
  return block.split("\n", 1).at(0) ?? ""
}

function packageName(block: string): string {
  return PACKAGE_LINE.exec(block)?.[1]?.toLowerCase() ?? ""
}

// `# via mcp` under a package that something else also needs.
function withoutAnnotationsOf(block: string, excluded: ReadonlySet<string>): string {
  return block
    .split("\n")
    .filter((line) => {
      const annotated = /^\s*#\s+(?:via\s+)?([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/.exec(line)?.[1]
      return annotated === undefined || !excluded.has(annotated.toLowerCase())
    })
    .join("\n")
}

// uv reads the requirement from standard input, which only the synchronous form can pass.
function compileLock(): string {
  return execFileSync(
    "uv",
    ["pip", "compile", "-", "--overrides", OVERRIDES, "--universal", "--generate-hashes", "--python-version", OLDEST_PYTHON, "--only-binary", ":all:", "--no-header", "--quiet"],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, input: `semgrep==${SEMGREP_VERSION}\n` },
  )
}

if (import.meta.main) {
  await writeFile(LOCK, withoutExcludedPackages(compileLock()))
  console.log(`Wrote ${LOCK} for Semgrep ${SEMGREP_VERSION}.`)
}
