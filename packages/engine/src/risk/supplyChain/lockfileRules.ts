import { codeSpan, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { isPrivatePackage } from "../dependencies/packageTrust.ts"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import type { LockedPackage } from "./lockedPackage.ts"
import { describeOrigin, isInsecure, isPublicRegistry, OriginKind, originKey } from "./packageOrigin.ts"

/** One lockfile at the merge base and at head. */
export interface LockfileVersions {
  readonly path: string
  readonly before: readonly LockedPackage[]
  readonly after: readonly LockedPackage[]
  /** The head text, to link each finding to its package's entry. */
  readonly text: string
}

function rule(id: string, severity: RiskSeverity, title: string, detail: string): RuleDescription {
  return { id: `supply-chain.${id}`, category: RiskCategory.SupplyChain, severity, title, detail }
}

/**
 * Compares what a lockfile pins before and after the PR, package by package. Only entries the PR
 * adds or changes are judged: an entry that was already there was already reviewed.
 */
export function lockfileFindings(lockfile: LockfileVersions, privatePackages: readonly string[]): Risk[] {
  const earlierByName = byName(lockfile.before)
  return distinctVersions(lockfile.after).flatMap((entry) => {
    const earlier = earlierByName.get(entry.name) ?? []
    const evidence = `${entry.name} ${entry.version}`
    const line = lineOf(lockfile.text, entry.anchor)
    return rulesFor(entry, earlier, isPrivatePackage(entry.name, privatePackages)).map((found) => findingAt(found, lockfile.path, line, evidence))
  })
}

function rulesFor(entry: LockedPackage, earlier: readonly LockedPackage[], isPrivate: boolean): RuleDescription[] {
  const unchanged = earlier.find((previous) => previous.version === entry.version && originKey(previous.origin) === originKey(entry.origin))
  if (unchanged !== undefined) return hashChanged(unchanged, entry) ? [integrityChanged(entry)] : []
  if (isPrivate && isPublicRegistry(entry.origin) && !earlier.some((previous) => isPublicRegistry(previous.origin))) return [dependencyConfusion(entry)]
  return [...sourceRules(entry, earlier), ...installScriptRules(entry, earlier)]
}

// A registry never serves different files for a version it already published, and a URL's
// content shouldn't change either. A git dependency's hash follows the commit it's pinned to.
function hashChanged(before: LockedPackage, after: LockedPackage): boolean {
  if (after.origin.kind === OriginKind.Git || after.origin.kind === OriginKind.Local) return false
  return [...after.hashes].some(([key, hash]) => {
    const previous = before.hashes.get(key)
    return previous !== undefined && previous !== hash
  })
}

function sourceRules(entry: LockedPackage, earlier: readonly LockedPackage[]): RuleDescription[] {
  if (isInsecure(entry.origin)) return [insecureSource(entry)]
  if (earlier.length > 0) {
    const sameSource = earlier.some((previous) => originKey(previous.origin) === originKey(entry.origin))
    const previous = earlier[0]
    return sameSource || previous === undefined ? [] : [sourceChanged(entry, previous)]
  }
  if (entry.origin.kind === OriginKind.Git) return [gitSource(entry)]
  if (entry.origin.kind === OriginKind.Url) return [urlSource(entry)]
  return []
}

function installScriptRules(entry: LockedPackage, earlier: readonly LockedPackage[]): RuleDescription[] {
  if (!entry.runsInstallScript) return []
  if (earlier.length === 0) return [installScript(entry)]
  return earlier.some((previous) => previous.runsInstallScript) ? [] : [installScriptAdded(entry)]
}

function integrityChanged(entry: LockedPackage): RuleDescription {
  return rule(
    "integrity-changed",
    RiskSeverity.High,
    `${codeSpan(`${entry.name} ${entry.version}`)} has a different content hash than before`,
    "The same version from the same source should never change. Either the lockfile was edited by hand, or a registry or mirror served different files. Find out where the new hash came from before installing.",
  )
}

function dependencyConfusion(entry: LockedPackage): RuleDescription {
  return rule(
    "dependency-confusion",
    RiskSeverity.High,
    `Private package ${codeSpan(entry.name)} now comes from the public registry ${describeOrigin(entry.origin)}`,
    "Anyone can publish a package under your private name on a public registry, and installs may pick it up: the dependency confusion attack. Check the registry settings for this package or its scope.",
  )
}

function insecureSource(entry: LockedPackage): RuleDescription {
  return rule(
    "insecure-source",
    RiskSeverity.Medium,
    `${codeSpan(entry.name)} downloads over an unencrypted connection`,
    `It comes from ${describeOrigin(entry.origin)}, so anyone on the network path can swap it. Use an https source.`,
  )
}

function sourceChanged(entry: LockedPackage, previous: LockedPackage): RuleDescription {
  return rule(
    "source-changed",
    RiskSeverity.Medium,
    `${codeSpan(entry.name)} now comes from ${describeOrigin(entry.origin)} instead of ${describeOrigin(previous.origin)}`,
    "Moving a package to another source is how a fork or a takeover gets in. Check the change is intended and the new source is trusted.",
  )
}

function gitSource(entry: LockedPackage): RuleDescription {
  return rule(
    "git-source",
    RiskSeverity.Low,
    `${codeSpan(entry.name)} is installed from a git repository`,
    `It comes from ${describeOrigin(entry.origin)} rather than a registry, so nothing records who published it. Check the repository is trusted and the lockfile pins a commit.`,
  )
}

function urlSource(entry: LockedPackage): RuleDescription {
  return rule(
    "url-source",
    RiskSeverity.Medium,
    `${codeSpan(entry.name)} is downloaded from a URL`,
    `It comes from ${describeOrigin(entry.origin)} rather than a registry, so whoever controls that address controls the code. Check that's intended.`,
  )
}

function installScript(entry: LockedPackage): RuleDescription {
  return rule(
    "install-script",
    RiskSeverity.Low,
    `${codeSpan(entry.name)} runs an install script`,
    "It runs its own code on every machine that installs it, before anyone imports it. Most packages that do this build native code; check this one needs to.",
  )
}

function installScriptAdded(entry: LockedPackage): RuleDescription {
  return rule(
    "install-script-added",
    RiskSeverity.Medium,
    `${codeSpan(`${entry.name} ${entry.version}`)} now runs an install script`,
    "The version locked before didn't. Compromised releases often add one to run code on developer and CI machines. Check the release notes and what the script does.",
  )
}

// The project targets ES2023, which doesn't have Map.groupBy.
function byName(entries: readonly LockedPackage[]): Map<string, LockedPackage[]> {
  const grouped = new Map<string, LockedPackage[]>()
  for (const entry of entries) {
    const group = grouped.get(entry.name)
    if (group === undefined) grouped.set(entry.name, [entry])
    else group.push(entry)
  }
  return grouped
}

// npm installs one version in several places; one finding per version is enough.
function distinctVersions(entries: readonly LockedPackage[]): LockedPackage[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.name}\0${entry.version}\0${originKey(entry.origin)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function lineOf(text: string, anchor: string): number | null {
  const index = text.indexOf(anchor)
  if (index === -1) return null
  let line = 1
  for (let position = text.indexOf("\n"); position !== -1 && position < index; position = text.indexOf("\n", position + 1)) line++
  return line
}
