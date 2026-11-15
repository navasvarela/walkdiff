import { basename } from "node:path"
import { CheckId, FileChangeStatus, isTestPath, NoiseKind } from "@walkdiff/review-model"
import type { CheckRun, CommitSha, FileDiff, Risk } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import { Ecosystem } from "../dependencies/ecosystem.ts"
import { TURNED_OFF_IN_SETTINGS } from "../scanners/scanWorkspace.ts"
import type { ScannedFile } from "../scannedFile.ts"
import type { ScanOutcome } from "../scanners/scanWorkspace.ts"
import { packageConfigFindings } from "./configRules.ts"
import type { LockfileReader } from "./lockedPackage.ts"
import { lockfileFindings } from "./lockfileRules.ts"
import type { LockfileVersions } from "./lockfileRules.ts"
import { checkNpmUpgrades, lookUpNpmRelease } from "./npmReleases.ts"
import type { PackageUpgrade, ReleaseLookup } from "./npmReleases.ts"
import { npmUpgrades } from "./upgrades.ts"
import { PACKAGE_LOCK, PNPM_LOCK, YARN_LOCK } from "./npmLockfiles.ts"
import { CARGO_LOCK, GO_SUM, POETRY_LOCK, UV_LOCK } from "./otherLockfiles.ts"

export interface SupplyChainScanRequest {
  readonly repoDir: string
  readonly base: CommitSha
  readonly head: CommitSha
  readonly files: readonly ScannedFile[]
  /** Team-owned package names, which must never come from a public registry or be sent to one. */
  readonly privatePackages: readonly string[]
  /** False skips asking npm about upgraded packages. */
  readonly network: boolean
  /** Checks the person turned off. */
  readonly disabled: ReadonlySet<CheckId>
  /** Replaces npm in tests. */
  readonly lookUpRelease?: ReleaseLookup
}

/** One lockfile read at both commits. */
interface ReadLockfile extends LockfileVersions {
  readonly reader: LockfileReader
}

const SUPPLY_CHAIN_CHECK: CheckRun = { name: "Supply chain", detail: "lockfile sources, content hashes and install scripts, and package-manager settings" }
const NPM_RELEASES_CHECK = "npm release history"
const NPM_RELEASES_RUN: CheckRun = { name: NPM_RELEASES_CHECK, detail: "who published upgraded npm packages, and whether they kept provenance" }
const LOCKFILE_READERS: readonly LockfileReader[] = [PACKAGE_LOCK, YARN_LOCK, PNPM_LOCK, CARGO_LOCK, UV_LOCK, POETRY_LOCK, GO_SUM]

/**
 * How the packages a PR depends on reach the build, separately from whether they're vulnerable:
 * lockfile entries that change source or content, gain install scripts or move a private name to a
 * public registry, and settings that change registries or what runs on install. Those read only
 * the repository. Online, upgraded npm packages are also checked against how their earlier
 * releases were published.
 */
export async function scanSupplyChain(request: SupplyChainScanRequest): Promise<ScanOutcome<Risk>> {
  const outcome: ScanOutcome<Risk> = { findings: packageConfigFindings(request.files), checksRun: [SUPPLY_CHAIN_CHECK], notChecked: [] }
  const lockfiles = await readLockfiles(request, outcome)
  for (const lockfile of lockfiles) outcome.findings.push(...lockfileFindings(lockfile, request.privatePackages))
  const upgrades = lockfiles.filter((lockfile) => lockfile.reader.ecosystem === Ecosystem.Npm).flatMap((lockfile) => npmUpgrades(lockfile, request.privatePackages))
  if (upgrades.length > 0) await checkNpmReleasesInto(upgrades, request, outcome)
  return outcome
}

async function checkNpmReleasesInto(upgrades: readonly PackageUpgrade[], request: SupplyChainScanRequest, outcome: ScanOutcome<Risk>): Promise<void> {
  if (request.disabled.has(CheckId.NpmReleases)) {
    outcome.notChecked.push({ check: NPM_RELEASES_CHECK, reason: TURNED_OFF_IN_SETTINGS })
    return
  }
  if (!request.network) {
    outcome.notChecked.push({ check: NPM_RELEASES_CHECK, reason: "offline mode: npm was not queried" })
    return
  }
  const { findings, problem } = await checkNpmUpgrades(upgrades, request.lookUpRelease ?? lookUpNpmRelease)
  outcome.findings.push(...findings)
  if (problem === undefined) outcome.checksRun.push(NPM_RELEASES_RUN)
  else outcome.notChecked.push({ check: NPM_RELEASES_CHECK, reason: problem })
}

/** Each changed lockfile at both commits; one that can't be parsed is reported as not checked. */
async function readLockfiles(request: SupplyChainScanRequest, outcome: ScanOutcome<Risk>): Promise<ReadLockfile[]> {
  const lockfiles = request.files.filter((file) => isReadableLockfile(file))
  if (lockfiles.length === 0) return []
  const blobs = await readBlobs(
    request.repoDir,
    lockfiles.flatMap(({ diff }) => [
      { commit: request.base, path: previousPathOf(diff) },
      { commit: request.head, path: diff.path },
    ]),
  )
  return lockfiles.flatMap(({ diff }, index) => {
    const before = blobs.at(2 * index)?.toString("utf8")
    const after = blobs.at(2 * index + 1)?.toString("utf8")
    const reader = readerFor(diff.path)
    if (after === undefined || reader === undefined) return []
    try {
      return [{ reader, path: diff.path, before: before === undefined ? [] : reader.read(before), after: reader.read(after), text: after }]
    } catch (error: unknown) {
      outcome.notChecked.push({ check: `Supply chain: ${diff.path}`, reason: `couldn't read the lockfile: ${error instanceof Error ? error.message : String(error)}` })
      return []
    }
  })
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
