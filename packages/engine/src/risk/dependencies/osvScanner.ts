import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { CheckId, FileChangeStatus } from "@walkdiff/review-model"
import type { CheckRun, CommitSha, FileDiff, SkippedCheck } from "@walkdiff/review-model"
import { z } from "zod"
import { readBlobs } from "../../blobs.ts"
import { TURNED_OFF_IN_SETTINGS } from "../scanners/scanWorkspace.ts"
import { firstErrorLine } from "../scanners/scannerProcess.ts"
import type { ScannerProcessRunner } from "../scanners/scannerProcess.ts"
import { toKnownVulnerability, vulnerabilitySchema } from "./osv.ts"
import type { VulnerablePackage } from "./osv.ts"
import { Ecosystem, UNSCANNABLE_LOCKFILES } from "./packages.ts"

export const OSV_SCANNER_BINARY = "osv-scanner"

const VULNERABILITY_CHECK = "Known vulnerabilities in new dependency versions"
const INSTALL_HINT = "not read without osv-scanner. Run `walkdiff setup`, or use `brew install osv-scanner`"
// osv-scanner exits 0 with nothing found and 1 with vulnerabilities; both are good runs.
const OSV_SCANNER_OK_EXIT_CODES: ReadonlySet<number> = new Set([0, 1])
const OSV_SCANNER_CHECK: CheckRun = { name: "osv-scanner", detail: "pnpm, yarn and bun lockfiles" }

const osvScannerOutputSchema = z.object({
  results: z
    .array(
      z.object({
        packages: z.array(
          z.object({
            package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string() }),
            vulnerabilities: z.array(vulnerabilitySchema).default([]),
          }),
        ),
      }),
    )
    .default([]),
})

export interface LockfileVulnerability {
  readonly found: VulnerablePackage
  readonly lockfile: string
  readonly text: string
}

export interface LockfileScan {
  readonly vulnerable: LockfileVulnerability[]
  readonly checksRun: CheckRun[]
  readonly notChecked: SkippedCheck[]
}

export interface LockfileScanOptions {
  readonly repoDir: string
  readonly base: CommitSha
  readonly head: CommitSha
  readonly network: boolean
  readonly runScanner: ScannerProcessRunner
  readonly disabled?: ReadonlySet<CheckId>
}

/**
 * Checks lockfiles this engine does not parse (pnpm, yarn, bun), by scanning both versions
 * and keeping what is new at head, so a PR is not blamed for vulnerabilities already there.
 */
export async function scanUnreadLockfiles(lockfiles: readonly FileDiff[], options: LockfileScanOptions): Promise<LockfileScan> {
  const result: LockfileScan = { vulnerable: [], checksRun: [], notChecked: [] }
  const skip = (path: string, reason: string): void => {
    result.notChecked.push({ check: `${VULNERABILITY_CHECK} (${path})`, reason })
  }
  const scannable = lockfiles.filter((diff) => !UNSCANNABLE_LOCKFILES.has(basename(diff.path)))
  lockfiles.filter((diff) => UNSCANNABLE_LOCKFILES.has(basename(diff.path))).forEach((diff) => skip(diff.path, "this lockfile format is binary and cannot be read"))
  if (scannable.length === 0) return result
  if (options.disabled?.has(CheckId.OsvScanner)) {
    scannable.forEach((diff) => skip(diff.path, TURNED_OFF_IN_SETTINGS))
    return result
  }
  if (!options.network) {
    scannable.forEach((diff) => skip(diff.path, "offline mode: the OSV database was not queried"))
    return result
  }

  const workspace = await mkdtemp(join(tmpdir(), "walkdiff-osv-"))
  try {
    const blobs = await readBlobs(
      options.repoDir,
      scannable.flatMap((diff) => [
        { commit: options.base, path: diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? diff.previousPath : diff.path },
        { commit: options.head, path: diff.path },
      ]),
    )
    for (const [index, diff] of scannable.entries()) {
      const text = blobs.at(2 * index + 1)?.toString("utf8")
      if (text === undefined) continue
      const before = await scanVersion(options.runScanner, workspace, `before-${index}`, basename(diff.path), blobs.at(2 * index)?.toString("utf8"))
      const after = await scanVersion(options.runScanner, workspace, `after-${index}`, basename(diff.path), text)
      if (after.status === "missing") {
        skip(diff.path, INSTALL_HINT)
        continue
      }
      if (after.status === "failed" || before.status === "failed") {
        const reason = after.status === "failed" ? after.reason : before.status === "failed" ? before.reason : ""
        skip(diff.path, `osv-scanner failed: ${reason}`)
        continue
      }
      const known = new Set(before.status === "scanned" ? before.found.map(findingKey) : [])
      for (const found of after.status === "scanned" ? after.found : []) {
        if (!known.has(findingKey(found))) result.vulnerable.push({ found, lockfile: diff.path, text })
      }
      if (!result.checksRun.includes(OSV_SCANNER_CHECK)) result.checksRun.push(OSV_SCANNER_CHECK)
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
  return result
}

type VersionScan =
  | { readonly status: "scanned"; readonly found: VulnerablePackage[] }
  | { readonly status: "absent" }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly reason: string }

async function scanVersion(run: ScannerProcessRunner, workspace: string, folder: string, fileName: string, text: string | undefined): Promise<VersionScan> {
  if (text === undefined) return { status: "absent" }
  const dir = join(workspace, folder)
  await mkdir(dir)
  await writeFile(join(dir, fileName), text)
  const result = await run(OSV_SCANNER_BINARY, ["scan", "source", "--format", "json", "--lockfile", fileName], dir)
  if (result === undefined) return { status: "missing" }
  if (!OSV_SCANNER_OK_EXIT_CODES.has(result.exitCode)) return { status: "failed", reason: firstErrorLine(result) }
  try {
    return { status: "scanned", found: parseOsvScannerOutput(result.stdout) }
  } catch (error: unknown) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

export function parseOsvScannerOutput(stdout: string): VulnerablePackage[] {
  const output = osvScannerOutputSchema.parse(JSON.parse(stdout))
  return output.results.flatMap((result) =>
    result.packages.flatMap((entry) => {
      // These lockfiles only ever hold npm packages.
      if (entry.package.ecosystem !== Ecosystem.Npm) return []
      const version = { ecosystem: Ecosystem.Npm, name: entry.package.name, version: entry.package.version }
      return entry.vulnerabilities.map((vulnerability) => ({ package: version, vulnerability: toKnownVulnerability(vulnerability.id, vulnerability, version) }))
    }),
  )
}

function findingKey({ package: entry, vulnerability }: VulnerablePackage): string {
  return `${entry.name}\0${entry.version}\0${vulnerability.id}`
}
