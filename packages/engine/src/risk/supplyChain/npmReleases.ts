import { codeSpan, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { z } from "zod"
import { getRegistryJson, npmPackagePath, RegistryUnavailableError } from "../dependencies/registryHttp.ts"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"

/** What npm records about who published one release, and how. */
export interface NpmRelease {
  /** The npm account that published it. */
  readonly publisher: string | undefined
  /** The accounts allowed to publish the package when this release came out. */
  readonly maintainers: ReadonlySet<string>
  /** Whether it carries a provenance attestation, which ties it to a CI build of a repository. */
  readonly hasProvenance: boolean
  /** Published by CI through npm's trusted publishing, rather than with an account's token. */
  readonly trustedPublisher: boolean
}

/** One release's record, or undefined when npm has no such release. Throws RegistryUnavailableError. */
export type ReleaseLookup = (name: string, version: string) => Promise<NpmRelease | undefined>

/** A package a lockfile moves from one version to another. */
export interface PackageUpgrade {
  readonly name: string
  readonly from: string
  readonly to: string
  readonly path: string
  readonly line: number | null
}

export interface ReleaseCheck {
  readonly findings: Risk[]
  /** Why some upgrades weren't checked; undefined when all of them were. */
  readonly problem: string | undefined
}

// Each upgrade costs two small requests to npm. A full lockfile refresh in a large project upgrades
// a few hundred packages within their release lines (vite's reached 261), which at 16 at a time
// takes seconds; the cap bounds the rare refresh that's larger still.
const MAX_UPGRADES = 300
const CONCURRENT_UPGRADES = 16
const NPM_REGISTRY = "https://registry.npmjs.org"

function rule(id: string, severity: RiskSeverity, title: string, detail: string): RuleDescription {
  return { id: `supply-chain.${id}`, category: RiskCategory.SupplyChain, severity, title, detail }
}

/**
 * Compares each upgraded npm package's new release with the one it replaces. A takeover usually
 * shows in how a release was published rather than in its code: by an account that wasn't a
 * maintainer before, or from a token instead of the CI build that published earlier releases.
 */
export async function checkNpmUpgrades(upgrades: readonly PackageUpgrade[], lookUp: ReleaseLookup): Promise<ReleaseCheck> {
  const checked = upgrades.slice(0, MAX_UPGRADES)
  const problems = upgrades.length > checked.length ? [`only the first ${MAX_UPGRADES} of ${upgrades.length} upgraded npm packages were checked`] : []
  const findings: Risk[] = []
  for (let start = 0; start < checked.length; start += CONCURRENT_UPGRADES) {
    const batch = await Promise.all(checked.slice(start, start + CONCURRENT_UPGRADES).map((upgrade) => upgradeFindings(upgrade, lookUp, problems)))
    findings.push(...batch.flat())
  }
  return { findings, problem: problems.at(0) }
}

async function upgradeFindings(upgrade: PackageUpgrade, lookUp: ReleaseLookup, problems: string[]): Promise<Risk[]> {
  try {
    const [before, after] = await Promise.all([lookUp(upgrade.name, upgrade.from), lookUp(upgrade.name, upgrade.to)])
    if (before === undefined || after === undefined) return []
    return releaseRules(upgrade, before, after).map((found) => findingAt(found, upgrade.path, upgrade.line, `${upgrade.name} ${upgrade.from} → ${upgrade.to}`))
  } catch (error: unknown) {
    if (!(error instanceof RegistryUnavailableError)) throw error
    problems.push(error.message)
    return []
  }
}

function releaseRules(upgrade: PackageUpgrade, before: NpmRelease, after: NpmRelease): RuleDescription[] {
  const release = codeSpan(`${upgrade.name} ${upgrade.to}`)
  const found: RuleDescription[] = []
  if (before.hasProvenance && !after.hasProvenance) {
    found.push(
      rule(
        "provenance-dropped",
        RiskSeverity.Medium,
        `${release} was published without provenance, unlike ${upgrade.from}`,
        "Provenance ties a release to a CI build of the project's repository. A release without it, after releases with it, is what publishing from a stolen token looks like. Check the release on npm and in the project's repository before installing.",
      ),
    )
  }
  if (isNewPublisher(before, after) && after.publisher !== undefined) {
    found.push(
      rule(
        "new-publisher",
        // Projects take on maintainers far more often than accounts are stolen. Replaying vite's
        // lockfile refreshes found a few new maintainers among hundreds of upgrades, all genuine.
        RiskSeverity.Low,
        `${release} was published by ${codeSpan(after.publisher)}, who wasn't a maintainer of ${upgrade.from}`,
        "Takeovers often start with a new maintainer, or a stolen account, publishing a release. Check that this account belongs to the project and that the release is expected.",
      ),
    )
  }
  return found
}

// A release built by CI with provenance or trusted publishing says where it came from, so a change
// of account, such as a move to trusted publishing itself, isn't suspicious on its own.
function isNewPublisher(before: NpmRelease, after: NpmRelease): boolean {
  if (after.hasProvenance || after.trustedPublisher || after.publisher === undefined || before.maintainers.size === 0) return false
  return after.publisher !== before.publisher && !before.maintainers.has(after.publisher)
}

const npmReleaseSchema = z
  .object({
    _npmUser: z.object({ name: z.string(), trustedPublisher: z.unknown().optional() }).loose().optional(),
    maintainers: z.array(z.object({ name: z.string() }).loose()).default([]),
    dist: z.object({ attestations: z.object({ provenance: z.unknown().optional() }).loose().optional() }).loose().optional(),
  })
  .loose()

/** Asks npm for one release's manifest, which is small, rather than the package's whole history. */
export const lookUpNpmRelease: ReleaseLookup = async (name, version) => {
  const body = await getRegistryJson(`${NPM_REGISTRY}/${npmPackagePath(name)}/${encodeURIComponent(version)}`, "npm")
  if (body === undefined) return undefined
  const parsed = npmReleaseSchema.safeParse(body)
  if (!parsed.success) throw new RegistryUnavailableError(`npm sent an unexpected answer for ${name} ${version}`)
  const { _npmUser: publisher, maintainers, dist } = parsed.data
  return {
    publisher: publisher?.name,
    maintainers: new Set(maintainers.map((maintainer) => maintainer.name)),
    hasProvenance: dist?.attestations?.provenance !== undefined,
    trustedPublisher: publisher?.trustedPublisher !== undefined,
  }
}
