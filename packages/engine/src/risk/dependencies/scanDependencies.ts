import { basename } from "node:path"
import { codeSpan, FileChangeStatus, RiskCategory, RiskSeverity, CheckId } from "@walkdiff/review-model"
import type { CheckRun, CommitSha, FileDiff, Risk, SkippedCheck } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import { findVulnerabilities, isMaliciousAdvisory, OsvUnavailableError } from "./osv.ts"
import type { VulnerablePackage } from "./osv.ts"
import { scanUnreadLockfiles } from "./osvScanner.ts"
import { assessPackageTrust, isFromRegistry, isPrivatePackage, LIVE_TRUST_SOURCES } from "./packageTrust.ts"
import type { DeclaredPackage, TrustSources } from "./packageTrust.ts"
import { lockfileFormatFor, manifestFormatFor, UNREAD_LOCKFILES } from "./packages.ts"
import { TURNED_OFF_IN_SETTINGS } from "../scanners/scanWorkspace.ts"
import type { ScannerProcessRunner } from "../scanners/scannerProcess.ts"
import type { PackageVersion } from "./packages.ts"

export interface DependencyScanRequest {
  readonly repoDir: string
  readonly base: CommitSha
  readonly head: CommitSha
  readonly diffs: readonly FileDiff[]
  /** False skips the OSV lookup, which sends package names and versions to api.osv.dev. */
  readonly network: boolean
  readonly runScanner: ScannerProcessRunner
  /** Checks the person turned off. */
  readonly disabled?: ReadonlySet<CheckId>
  /** Team-owned package names, never sent to a public service. From the merge base's config. */
  readonly privatePackages?: readonly string[]
  /** SPDX identifiers the team accepts; undefined leaves licences unchecked. From the merge base's config. */
  readonly allowedLicenses?: readonly string[] | undefined
  /** Replaces the live services in tests. */
  readonly trustSources?: TrustSources
  readonly now?: Date
}

export interface DependencyScan {
  readonly findings: Risk[]
  readonly checksRun: CheckRun[]
  readonly notChecked: SkippedCheck[]
}

const OSV_DATABASE_CHECK: CheckRun = { name: "OSV database", detail: "package versions new to lockfiles" }

const VULNERABILITY_CHECK = "Known vulnerabilities in new dependency versions"
const TRUST_CHECK = "Dependency trust"
const LICENSE_CHECK_RUN: CheckRun = { name: "Licences", detail: "new direct dependencies against your allowlist" }
const TRUST_CHECK_RUN: CheckRun = { name: TRUST_CHECK, detail: "new direct dependencies: known malicious, not on the registry, very new or a lookalike name" }

const NEW_DEPENDENCY: RuleDescription = {
  id: "dependency.added",
  category: RiskCategory.Dependency,
  severity: RiskSeverity.Low,
  title: "New dependency",
  detail: "New code from outside the team. Check it is maintained, its licence fits, and it is really needed.",
}

/**
 * Compares manifests and lockfiles between the merge base and head: newly declared
 * dependencies become findings, and package versions new to a lockfile are checked
 * against the OSV vulnerability database.
 */
export async function scanDependencies(request: DependencyScanRequest): Promise<DependencyScan> {
  const scan: DependencyScan = { findings: [], checksRun: [], notChecked: [] }
  await scanUnreadLockfilesInto(request, scan)
  const changes = await readManifestChanges(request)
  scan.findings.push(...changes.noted)
  await checkTrustInto(changes.declared, request, scan)
  await checkVulnerabilitiesInto(changes, request, scan)
  return scan
}

interface NewVersion {
  readonly version: PackageVersion
  readonly lockfile: string
  readonly text: string
}

interface ManifestChanges {
  readonly noted: readonly Risk[]
  readonly declared: readonly DeclaredPackage[]
  readonly newVersions: readonly NewVersion[]
}

async function readManifestChanges(request: DependencyScanRequest): Promise<ManifestChanges> {
  const relevant = request.diffs.filter((diff) => diff.status !== FileChangeStatus.Deleted && (manifestFormatFor(diff.path) ?? lockfileFormatFor(diff.path)) !== undefined)
  if (relevant.length === 0) return { noted: [], declared: [], newVersions: [] }
  const blobs = await readBlobs(
    request.repoDir,
    relevant.flatMap((diff) => [
      { commit: request.base, path: previousPathOf(diff) },
      { commit: request.head, path: diff.path },
    ]),
  )
  const privatePackages = request.privatePackages ?? []
  const noted: Risk[] = []
  const declared: DeclaredPackage[] = []
  const newVersions: NewVersion[] = []
  relevant.forEach((diff, index) => {
    const before = blobs.at(2 * index)?.toString("utf8")
    const after = blobs.at(2 * index + 1)?.toString("utf8")
    if (after === undefined) return
    noted.push(...newlyDeclared(diff.path, before, after))
    declared.push(...newlyDeclaredPackages(diff.path, before, after, privatePackages))
    for (const version of newlyLocked(diff.path, before, after)) {
      if (!isPrivatePackage(version.name, privatePackages)) newVersions.push({ version, lockfile: diff.path, text: after })
    }
  })
  return { noted, declared, newVersions }
}

async function checkVulnerabilitiesInto({ declared, newVersions }: ManifestChanges, request: DependencyScanRequest, scan: DependencyScan): Promise<void> {
  if (newVersions.length === 0) return
  if (request.disabled?.has(CheckId.OsvDatabase)) {
    scan.notChecked.push({ check: VULNERABILITY_CHECK, reason: TURNED_OFF_IN_SETTINGS })
    return
  }
  if (!request.network) {
    scan.notChecked.push({ check: VULNERABILITY_CHECK, reason: "offline mode: the OSV database was not queried" })
    return
  }
  try {
    const vulnerable = withoutAliasDuplicates(await findVulnerabilities(newVersions.map((entry) => entry.version)))
    for (const found of vulnerable) {
      const source = newVersions.find((entry) => entry.version === found.package)
      // The trust check already says this about a package the PR declares, with what to do about it.
      const alreadyFlagged = isMaliciousAdvisory(found.vulnerability.id) && declared.some((entry) => entry.name === found.package.name)
      if (source !== undefined && !alreadyFlagged) scan.findings.push(vulnerabilityFinding(found, source.lockfile, source.text))
    }
    scan.checksRun.push(OSV_DATABASE_CHECK)
  } catch (error: unknown) {
    if (!(error instanceof OsvUnavailableError)) throw error
    scan.notChecked.push({ check: VULNERABILITY_CHECK, reason: error.message })
  }
}

async function checkTrustInto(declared: readonly DeclaredPackage[], request: DependencyScanRequest, scan: DependencyScan): Promise<void> {
  if (declared.length === 0) return
  if (request.disabled?.has(CheckId.DependencyTrust)) {
    scan.notChecked.push({ check: TRUST_CHECK, reason: TURNED_OFF_IN_SETTINGS })
    return
  }
  if (!request.network) {
    scan.notChecked.push({ check: TRUST_CHECK, reason: "offline mode: package registries were not queried" })
    return
  }
  const { findings, problem } = await assessPackageTrust(declared, request.trustSources ?? LIVE_TRUST_SOURCES(request.now ?? new Date()), { allowedLicenses: request.allowedLicenses })
  // A stronger warning about a package replaces the routine note that it's new, so it reads as one thing.
  const flagged = new Set(findings.map(placeOf))
  const routineNotes = scan.findings.filter((finding) => finding.ruleId === NEW_DEPENDENCY.id && flagged.has(placeOf(finding)))
  for (const note of routineNotes) scan.findings.splice(scan.findings.indexOf(note), 1)
  scan.findings.push(...findings)
  if (problem === undefined) scan.checksRun.push(TRUST_CHECK_RUN, ...(request.allowedLicenses === undefined ? [] : [LICENSE_CHECK_RUN]))
  else scan.notChecked.push({ check: TRUST_CHECK, reason: problem })
}

function placeOf(finding: Risk): string {
  return `${finding.location?.path ?? ""}:${finding.location?.line ?? ""}`
}

async function scanUnreadLockfilesInto(request: DependencyScanRequest, scan: DependencyScan): Promise<void> {
  const lockfiles = request.diffs.filter((diff) => diff.status !== FileChangeStatus.Deleted && UNREAD_LOCKFILES.has(basename(diff.path)))
  const result = await scanUnreadLockfiles(lockfiles, request)
  scan.notChecked.push(...result.notChecked)
  scan.checksRun.push(...result.checksRun)
  for (const found of withoutAliasDuplicates(result.vulnerable.map((entry) => entry.found))) {
    const source = result.vulnerable.find((entry) => entry.found === found)
    if (source !== undefined) scan.findings.push(vulnerabilityFinding(found, source.lockfile, source.text))
  }
}

function newlyDeclared(path: string, before: string | undefined, after: string): Risk[] {
  const format = manifestFormatFor(path)
  if (format === undefined) return []
  const previous = before === undefined ? new Map<string, string>() : format.parse(before)
  return [...format.parse(after)]
    .filter(([name]) => !previous.has(name))
    .map(([name, requirement]) =>
      findingAt({ ...NEW_DEPENDENCY, title: `New dependency: ${codeSpan(name)}` }, path, lineMentioning(after, name), `${name} ${requirement}`),
    )
}

function newlyDeclaredPackages(path: string, before: string | undefined, after: string, privatePackages: readonly string[]): DeclaredPackage[] {
  const format = manifestFormatFor(path)
  if (format === undefined) return []
  const previous = before === undefined ? new Map<string, string>() : format.parse(before)
  return [...format.parse(after)]
    .filter(([name, requirement]) => !previous.has(name) && isFromRegistry(requirement) && !isPrivatePackage(name, privatePackages))
    .map(([name, requirement]) => ({ ecosystem: format.ecosystem, name, requirement, path, line: lineMentioning(after, name) }))
}

function newlyLocked(path: string, before: string | undefined, after: string): PackageVersion[] {
  const format = lockfileFormatFor(path)
  if (format === undefined) return []
  const key = (entry: PackageVersion): string => `${entry.ecosystem}\0${entry.name}\0${entry.version}`
  const previous = new Set((before === undefined ? [] : format.parse(before)).map(key))
  const seen = new Set<string>()
  return format.parse(after).filter((entry) => {
    const entryKey = key(entry)
    if (previous.has(entryKey) || seen.has(entryKey)) return false
    seen.add(entryKey)
    return true
  })
}

/**
 * Databases publish the same issue under several IDs (a GHSA advisory and a RUSTSEC or
 * PYSEC entry naming each other as aliases). Keeps one per issue and package, preferring
 * the more severe rating.
 */
function withoutAliasDuplicates(found: readonly VulnerablePackage[]): VulnerablePackage[] {
  const bySeverity = [...found].sort((a, b) => SEVERITY_RANK[a.vulnerability.severity] - SEVERITY_RANK[b.vulnerability.severity])
  const kept: VulnerablePackage[] = []
  for (const candidate of bySeverity) {
    const names = new Set([candidate.vulnerability.id, ...candidate.vulnerability.aliases])
    const duplicate = kept.some(
      (existing) =>
        existing.package === candidate.package &&
        [existing.vulnerability.id, ...existing.vulnerability.aliases].some((name) => names.has(name)),
    )
    if (!duplicate) kept.push(candidate)
  }
  return kept
}

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  [RiskSeverity.High]: 0,
  [RiskSeverity.Medium]: 1,
  [RiskSeverity.Low]: 2,
}

function vulnerabilityFinding(found: VulnerablePackage, lockfile: string, text: string): Risk {
  const { package: entry, vulnerability } = found
  const aliases = vulnerability.aliases.length > 0 ? ` (${vulnerability.aliases.join(", ")})` : ""
  const fix = vulnerability.fixedIn === undefined ? "No fixed version is recorded." : `Fixed in ${vulnerability.fixedIn}.`
  const rule: RuleDescription = {
    id: `vulnerability.${vulnerability.id}`,
    category: RiskCategory.Vulnerability,
    severity: vulnerability.severity,
    title: `${codeSpan(`${entry.name} ${entry.version}`)}: ${vulnerability.id}${aliases}`,
    detail: `${vulnerability.summary ?? "Known vulnerability."} ${fix}`,
  }
  return findingAt(rule, lockfile, lineMentioning(text, entry.name), `${entry.name} ${entry.version}`)
}

/**
 * First line naming the package, so a finding links to where it is declared or locked:
 * a quoted name (JSON, TOML values) or the name at the start of a line (TOML keys,
 * requirements files), never as part of a longer name.
 */
function lineMentioning(text: string, name: string): number | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`"${escaped}"|^\\s*${escaped}(?![\\w.-])`)
  const index = text.split("\n").findIndex((line) => pattern.test(line))
  return index === -1 ? null : index + 1
}

function previousPathOf(diff: FileDiff): string {
  return diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? diff.previousPath : diff.path
}
