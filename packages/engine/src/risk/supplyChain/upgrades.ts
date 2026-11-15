import { isPrivatePackage } from "../dependencies/packageTrust.ts"
import { lineOfAnchor } from "./lockedPackage.ts"
import type { LockfileVersions } from "./lockfileRules.ts"
import type { PackageUpgrade } from "./npmReleases.ts"
import { CONFIGURED_REGISTRY, OriginKind, PublicRegistry } from "./packageOrigin.ts"
import type { PackageOrigin } from "./packageOrigin.ts"

// pnpm and Yarn 2+ don't name the registry; most projects use npm's, or a mirror of it.
const NPM_SOURCES: ReadonlySet<string> = new Set([PublicRegistry.Npm, CONFIGURED_REGISTRY])

/**
 * Packages a lockfile moves to a newer version in the same release line, from the npm registry.
 * Private packages are left out, because their names must not be sent to npm.
 *
 * Only upgrades within a release line (same major, or same minor below 1.0) count: those are what
 * `^` and `~` ranges install without anyone choosing them, which is what takeovers rely on, while
 * a new major is a deliberate change whose publishing often changes too. Pairing by release line
 * also keeps a nested older copy, which npm installs beside the top-level one, from looking like a
 * downgrade of it.
 */
export function npmUpgrades(lockfile: LockfileVersions, privatePackages: readonly string[]): PackageUpgrade[] {
  const earlierVersions = new Map<string, string[]>()
  for (const entry of lockfile.before.filter((candidate) => isFromNpm(candidate.origin))) {
    const versions = earlierVersions.get(entry.name)
    if (versions === undefined) earlierVersions.set(entry.name, [entry.version])
    else versions.push(entry.version)
  }
  const seen = new Set<string>()
  return lockfile.after.flatMap((entry) => {
    const earlier = earlierVersions.get(entry.name)
    if (earlier === undefined || earlier.includes(entry.version) || !isFromNpm(entry.origin) || isPrivatePackage(entry.name, privatePackages)) return []
    const from = replacedVersion(earlier, entry.version)
    const key = `${entry.name}\0${from}\0${entry.version}`
    if (from === undefined || seen.has(key)) return []
    seen.add(key)
    return [{ name: entry.name, from, to: entry.version, path: lockfile.path, line: lineOfAnchor(lockfile.text, entry.anchor) }]
  })
}

function isFromNpm(origin: PackageOrigin): boolean {
  return origin.kind === OriginKind.Registry && NPM_SOURCES.has(origin.registry)
}

function replacedVersion(earlier: readonly string[], upgraded: string): string | undefined {
  const line = releaseLine(upgraded)
  return earlier
    .filter((version) => releaseLine(version) === line && compareVersions(version, upgraded) < 0)
    .sort(compareVersions)
    .at(-1)
}

// `1.4.2` → `1`, and `0.7.29` → `0.7`, because below 1.0 a minor release may break things.
function releaseLine(version: string): string {
  const [major = "", minor = ""] = version.split(/[.-]/)
  return major === "0" ? `0.${minor}` : major
}

// Enough of semver to order releases: numeric parts first, then a prerelease before its release.
function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split("-", 2)
  const [coreB = "", preB] = b.split("-", 2)
  const partsA = coreA.split(".").map(Number)
  const partsB = coreB.split(".").map(Number)
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0)
    if (difference !== 0 && !Number.isNaN(difference)) return difference
  }
  if (preA === preB) return 0
  if (preA === undefined) return 1
  return preB === undefined ? -1 : preA.localeCompare(preB)
}
