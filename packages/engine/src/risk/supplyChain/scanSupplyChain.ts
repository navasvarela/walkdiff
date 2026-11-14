import { basename } from "node:path"
import { FileChangeStatus, isTestPath, NoiseKind } from "@walkdiff/review-model"
import type { CheckRun, CommitSha, FileDiff, Risk } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import type { ScannedFile } from "../scannedFile.ts"
import type { ScanOutcome } from "../scanners/scanWorkspace.ts"
import { packageConfigFindings } from "./configRules.ts"
import type { LockfileReader } from "./lockedPackage.ts"
import { lockfileFindings } from "./lockfileRules.ts"
import { PACKAGE_LOCK, PNPM_LOCK, YARN_LOCK } from "./npmLockfiles.ts"
import { CARGO_LOCK, GO_SUM, POETRY_LOCK, UV_LOCK } from "./otherLockfiles.ts"

export interface SupplyChainScanRequest {
  readonly repoDir: string
  readonly base: CommitSha
  readonly head: CommitSha
  readonly files: readonly ScannedFile[]
  /** Team-owned package names, which must never come from a public registry. */
  readonly privatePackages: readonly string[]
}

const SUPPLY_CHAIN_CHECK: CheckRun = { name: "Supply chain", detail: "lockfile sources, content hashes and install scripts, and package-manager settings" }
const LOCKFILE_READERS: readonly LockfileReader[] = [PACKAGE_LOCK, YARN_LOCK, PNPM_LOCK, CARGO_LOCK, UV_LOCK, POETRY_LOCK, GO_SUM]

/**
 * How the packages a PR depends on reach the build, separately from whether they're vulnerable:
 * lockfile entries that change source or content, gain install scripts or move a private name to a
 * public registry, and settings that change registries or what runs on install. Reads only the
 * repository, so it runs offline.
 */
export async function scanSupplyChain(request: SupplyChainScanRequest): Promise<ScanOutcome<Risk>> {
  const lockfiles = request.files.filter((file) => isReadableLockfile(file))
  const outcome: ScanOutcome<Risk> = { findings: packageConfigFindings(request.files), checksRun: [SUPPLY_CHAIN_CHECK], notChecked: [] }
  if (lockfiles.length === 0) return outcome
  const blobs = await readBlobs(
    request.repoDir,
    lockfiles.flatMap(({ diff }) => [
      { commit: request.base, path: previousPathOf(diff) },
      { commit: request.head, path: diff.path },
    ]),
  )
  lockfiles.forEach(({ diff }, index) => {
    const before = blobs.at(2 * index)?.toString("utf8")
    const after = blobs.at(2 * index + 1)?.toString("utf8")
    const reader = readerFor(diff.path)
    if (after === undefined || reader === undefined) return
    try {
      outcome.findings.push(...lockfileFindings({ path: diff.path, before: before === undefined ? [] : reader.read(before), after: reader.read(after), text: after }, request.privatePackages))
    } catch (error: unknown) {
      outcome.notChecked.push({ check: `Supply chain: ${diff.path}`, reason: `couldn't read the lockfile: ${error instanceof Error ? error.message : String(error)}` })
    }
  })
  return outcome
}

// Lockfiles are marked as noise for reviewers, which is why the shared isThirdParty doesn't fit here:
// only vendored copies of someone else's lockfile are skipped.
function isReadableLockfile(file: ScannedFile): boolean {
  if (file.diff.status === FileChangeStatus.Deleted || file.noise?.kind === NoiseKind.Vendored || isTestPath(file.diff.path)) return false
  return readerFor(file.diff.path) !== undefined
}

function readerFor(path: string): LockfileReader | undefined {
  return LOCKFILE_READERS.find((reader) => reader.matches(basename(path)))
}

function previousPathOf(diff: FileDiff): string {
  return diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? diff.previousPath : diff.path
}
