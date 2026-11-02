import { matchesGlob } from "node:path"
import { codeSpan, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { z } from "zod"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import { findMaliciousPackages, OsvUnavailableError } from "./osv.ts"
import { Ecosystem, normalizePythonName } from "./packages.ts"
import { POPULAR_PACKAGES } from "./popularPackages.ts"

export interface DeclaredPackage {
  readonly ecosystem: Ecosystem
  readonly name: string
  readonly requirement: string
  readonly path: string
  readonly line: number | null
}

export const RegistryStatus = { Published: "published", Missing: "missing" } as const
export type RegistryStatus = (typeof RegistryStatus)[keyof typeof RegistryStatus]

export type RegistryEntry = { readonly status: typeof RegistryStatus.Published; readonly firstPublished: Date } | { readonly status: typeof RegistryStatus.Missing }

export interface TrustSources {
  readonly lookUp: (ecosystem: Ecosystem, name: string) => Promise<RegistryEntry>
  readonly maliciousNames: (packages: readonly DeclaredPackage[]) => Promise<ReadonlyMap<string, string>>
  readonly now: Date
}

export interface TrustResult {
  readonly findings: Risk[]
  /** Why some packages couldn't be looked up; undefined when all of them were. */
  readonly problem: string | undefined
}

// Most attacks on new packages are found within days. A month catches those without flagging
// ordinary young libraries for long, and is a judgement call rather than a measured value.
const NEW_PACKAGE_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000
// Shorter names sit one edit from many real packages, so comparing them is mostly noise.
const MIN_NAME_LENGTH_TO_COMPARE = 5
// Each lookup is a request to a public service, and a PR chooses how many packages it adds.
const MAX_LOOKUPS = 100
const CONCURRENT_LOOKUPS = 8
const REQUEST_TIMEOUT_MS = 15_000
// crates.io requires clients to identify themselves.
const USER_AGENT = "walkdiff (https://github.com/navasvarela/walkdiff)"

const REGISTRY_NAMES: Readonly<Record<Ecosystem, string>> = { [Ecosystem.Npm]: "npm", [Ecosystem.PyPI]: "PyPI", [Ecosystem.Crates]: "crates.io" }

/**
 * Requirements that don't come from a public registry, so a registry can't say anything about them:
 * local paths, workspaces, git and direct URLs.
 */
const NOT_FROM_REGISTRY = /^(workspace:|file:|link:|path:|portal:|git[+:]|github:|npm:)|:\/\/|^@\s/

export function isFromRegistry(requirement: string): boolean {
  return !NOT_FROM_REGISTRY.test(requirement.trim())
}

/** Whether a team listed this as its own package, which must not be sent to a public service. */
export function isPrivatePackage(name: string, privatePatterns: readonly string[]): boolean {
  return privatePatterns.some((pattern) => name === pattern || matchesGlob(name, pattern))
}

/**
 * Asks whether each new direct dependency can be trusted at all, separately from whether a version
 * has a known vulnerability. This matters most for AI-written code, which can name packages that
 * don't exist, and attackers register those names. Lockfile-only changes aren't checked: a package
 * nobody chose directly is rarely the one a person or model got wrong.
 */
export async function assessPackageTrust(packages: readonly DeclaredPackage[], sources: TrustSources): Promise<TrustResult> {
  const findings = packages.flatMap(lookalikeFinding)
  const looked = packages.filter((entry) => !POPULAR_PACKAGES[entry.ecosystem].has(entry.name))
  const toLookUp = looked.slice(0, MAX_LOOKUPS)
  const problems: string[] = []
  if (looked.length > toLookUp.length) problems.push(`only the first ${MAX_LOOKUPS} of ${looked.length} new packages were looked up`)

  try {
    const malicious = await sources.maliciousNames(packages)
    for (const entry of packages) {
      const advisory = malicious.get(entry.name)
      if (advisory !== undefined) findings.push(maliciousFinding(entry, advisory))
    }
  } catch (error: unknown) {
    if (!(error instanceof OsvUnavailableError)) throw error
    problems.push(error.message)
  }

  const results = await inBatches(toLookUp, CONCURRENT_LOOKUPS, async (entry) => {
    try {
      return registryFindings(entry, await sources.lookUp(entry.ecosystem, entry.name), sources.now)
    } catch (error: unknown) {
      if (!(error instanceof RegistryUnavailableError)) throw error
      problems.push(error.message)
      return []
    }
  })
  return { findings: [...findings, ...results.flat()], problem: problems.at(0) }
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))))
  }
  return results
}

function registryFindings(entry: DeclaredPackage, found: RegistryEntry, now: Date): Risk[] {
  if (found.status === RegistryStatus.Missing) return [missingFinding(entry)]
  const days = Math.floor((now.getTime() - found.firstPublished.getTime()) / MS_PER_DAY)
  return days < NEW_PACKAGE_DAYS ? [newPackageFinding(entry, days)] : []
}

function trustFinding(entry: DeclaredPackage, id: string, severity: RiskSeverity, title: string, detail: string): Risk {
  const rule: RuleDescription = { id: `trust.${id}`, category: RiskCategory.Dependency, severity, title, detail }
  return findingAt(rule, entry.path, entry.line, `${entry.name} ${entry.requirement}`)
}

function maliciousFinding(entry: DeclaredPackage, advisory: string): Risk {
  return trustFinding(entry, "malicious", RiskSeverity.High, `${codeSpan(entry.name)} is a known malicious package`, `It's listed in ${advisory}. Remove it, and if it was ever installed, treat that machine and its credentials as compromised.`)
}

function missingFinding(entry: DeclaredPackage): Risk {
  const registry = REGISTRY_NAMES[entry.ecosystem]
  return trustFinding(entry, "missing", RiskSeverity.Medium, `${codeSpan(entry.name)} isn't on ${registry}`, `The name may be made up, which AI tools do, and anyone could register it and run code on whoever installs it. If it's your team's private package, add it to dependencies.private in .walkdiff.json.`)
}

function newPackageFinding(entry: DeclaredPackage, days: number): Risk {
  const age = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  return trustFinding(entry, "new", RiskSeverity.Medium, `${codeSpan(entry.name)} was first published ${age}`, `Brand new packages have little history to trust, and attackers register names that AI tools suggest. Check who publishes it and that it's the package you meant.`)
}

function lookalikeFinding(entry: DeclaredPackage): Risk[] {
  const target = lookalikeTarget(entry)
  if (target === undefined) return []
  return [trustFinding(entry, "lookalike", RiskSeverity.Medium, `${codeSpan(entry.name)} looks like ${codeSpan(target)}`, `The names differ by one character or only in punctuation, a common way to trick people into installing the wrong package. Check this is the one you meant.`)]
}

function lookalikeTarget(entry: DeclaredPackage): string | undefined {
  const popular = POPULAR_PACKAGES[entry.ecosystem]
  if (popular.has(entry.name) || entry.name.startsWith("@")) return undefined
  const name = entry.ecosystem === Ecosystem.PyPI ? normalizePythonName(entry.name) : entry.name
  if (popular.has(name) || name.length < MIN_NAME_LENGTH_TO_COMPARE) return undefined
  return [...popular].find((known) => known.length >= MIN_NAME_LENGTH_TO_COMPARE && (withoutPunctuation(known) === withoutPunctuation(name) || isOneEditAway(known, name)))
}

function withoutPunctuation(name: string): string {
  return name.replace(/[-_.]/g, "").toLowerCase()
}

/** One character added, removed or changed, or two neighbours swapped. */
export function isOneEditAway(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  const restA = a.slice(start)
  const restB = b.slice(start)
  if (a.length === b.length) return restA.slice(1) === restB.slice(1) || (restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2))
  return a.length > b.length ? restA.slice(1) === restB : restA === restB.slice(1)
}

export class RegistryUnavailableError extends Error {
  override readonly name = "RegistryUnavailableError"
}

const npmSchema = z.object({ time: z.object({ created: z.iso.datetime({ offset: true }) }).loose() }).loose()
const pypiSchema = z.object({ releases: z.record(z.string(), z.array(z.object({ upload_time_iso_8601: z.string() }).loose())) }).loose()
const cratesSchema = z.object({ crate: z.object({ created_at: z.string() }).loose() }).loose()

interface RegistryClient {
  readonly url: (name: string) => string
  readonly firstPublished: (body: unknown) => Date | undefined
}

const REGISTRIES: Readonly<Record<Ecosystem, RegistryClient>> = {
  // A scoped name keeps its @ and has its slash encoded, as the registry expects.
  [Ecosystem.Npm]: { url: (name) => `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`, firstPublished: (body) => new Date(npmSchema.parse(body).time.created) },
  [Ecosystem.PyPI]: {
    url: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    firstPublished: (body) => {
      const times = Object.values(pypiSchema.parse(body).releases).flat().map((file) => new Date(file.upload_time_iso_8601).getTime())
      return times.length === 0 ? undefined : new Date(Math.min(...times))
    },
  },
  [Ecosystem.Crates]: { url: (name) => `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, firstPublished: (body) => new Date(cratesSchema.parse(body).crate.created_at) },
}

// A name reserved with no releases can't be installed, which to a reviewer is the same as missing.
export async function lookUpOnRegistry(ecosystem: Ecosystem, name: string): Promise<RegistryEntry> {
  const client = REGISTRIES[ecosystem]
  let response: Response
  try {
    response = await fetch(client.url(name), { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new RegistryUnavailableError(`could not reach ${REGISTRY_NAMES[ecosystem]}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 404) return { status: RegistryStatus.Missing }
  if (!response.ok) throw new RegistryUnavailableError(`${REGISTRY_NAMES[ecosystem]} responded ${response.status}`)
  try {
    const firstPublished = client.firstPublished(await response.json())
    return firstPublished === undefined ? { status: RegistryStatus.Missing } : { status: RegistryStatus.Published, firstPublished }
  } catch (error: unknown) {
    throw new RegistryUnavailableError(`${REGISTRY_NAMES[ecosystem]} sent an unexpected answer: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const LIVE_TRUST_SOURCES = (now: Date): TrustSources => ({ lookUp: lookUpOnRegistry, maliciousNames: findMaliciousPackages, now })
