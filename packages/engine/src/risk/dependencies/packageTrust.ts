import { matchesGlob } from "node:path"
import { codeSpan, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { z } from "zod"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import { findMaliciousPackages, OsvUnavailableError } from "./osv.ts"
import { isLicenseAllowed, pypiLicense } from "./licenses.ts"
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

export type RegistryEntry =
  | { readonly status: typeof RegistryStatus.Published; readonly firstPublished: Date; readonly license: string | undefined }
  | { readonly status: typeof RegistryStatus.Missing }

export interface TrustSources {
  readonly lookUp: (ecosystem: Ecosystem, name: string) => Promise<RegistryEntry>
  readonly maliciousNames: (packages: readonly DeclaredPackage[]) => Promise<ReadonlyMap<string, string>>
  readonly now: Date
}

export interface TrustOptions {
  /** SPDX identifiers a team accepts; undefined leaves licences unchecked. */
  readonly allowedLicenses: readonly string[] | undefined
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

const REGISTRY_NAMES: Readonly<Record<Ecosystem, string>> = {
  [Ecosystem.Npm]: "npm",
  [Ecosystem.PyPI]: "PyPI",
  [Ecosystem.Crates]: "crates.io",
  [Ecosystem.Go]: "the Go module proxy",
  [Ecosystem.Maven]: "Maven Central",
}

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
export async function assessPackageTrust(packages: readonly DeclaredPackage[], sources: TrustSources, options: TrustOptions = { allowedLicenses: undefined }): Promise<TrustResult> {
  const findings = packages.flatMap(lookalikeFinding)
  // A popular package needs no trust lookup, but still needs its licence read when a team checks them.
  const looked = options.allowedLicenses === undefined ? packages.filter((entry) => !POPULAR_PACKAGES[entry.ecosystem].has(entry.name)) : packages
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
      return registryFindings(entry, await sources.lookUp(entry.ecosystem, entry.name), sources.now, options.allowedLicenses)
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

function registryFindings(entry: DeclaredPackage, found: RegistryEntry, now: Date, allowedLicenses: readonly string[] | undefined): Risk[] {
  if (found.status === RegistryStatus.Missing) return [missingFinding(entry)]
  const days = Math.floor((now.getTime() - found.firstPublished.getTime()) / MS_PER_DAY)
  const isPopular = POPULAR_PACKAGES[entry.ecosystem].has(entry.name)
  return [...(days < NEW_PACKAGE_DAYS && !isPopular ? [newPackageFinding(entry, days)] : []), ...licenseFindings(entry, found.license, allowedLicenses)]
}

function licenseFindings(entry: DeclaredPackage, license: string | undefined, allowed: readonly string[] | undefined): Risk[] {
  if (allowed === undefined) return []
  const where = REGISTRY_NAMES[entry.ecosystem]
  if (license === undefined) {
    return [policyFinding(entry, "license.undeclared", RiskSeverity.Low, `${codeSpan(entry.name)} doesn't declare a licence on ${where}`, "Without a licence, you may have no right to use it. Check the project's repository.")]
  }
  if (isLicenseAllowed(license, allowed)) return []
  return [policyFinding(entry, "license.not-allowed", RiskSeverity.Medium, `${codeSpan(entry.name)} is licensed ${codeSpan(license)}, which isn't on your allowlist`, `Allowed: ${allowed.join(", ")}. Registries report what a project declares, which can be wrong, so check before deciding.`)]
}

function policyFinding(entry: DeclaredPackage, id: string, severity: RiskSeverity, title: string, detail: string): Risk {
  const rule: RuleDescription = { id, category: RiskCategory.License, severity, title, detail }
  return findingAt(rule, entry.path, entry.line, `${entry.name} ${entry.requirement}`)
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

const npmLicenseSchema = z.union([z.string(), z.object({ type: z.string() }).loose()]).optional()
const npmSchema = z
  .object({
    time: z.object({ created: z.iso.datetime({ offset: true }) }).loose(),
    "dist-tags": z.object({ latest: z.string() }).loose().optional(),
    versions: z.record(z.string(), z.object({ license: npmLicenseSchema }).loose()).optional(),
    license: npmLicenseSchema,
  })
  .loose()
const pypiSchema = z
  .object({
    info: z.object({ license: z.string().nullish(), license_expression: z.string().nullish(), classifiers: z.array(z.string()).default([]) }).loose(),
    releases: z.record(z.string(), z.array(z.object({ upload_time_iso_8601: z.string() }).loose())),
  })
  .loose()
const cratesSchema = z.object({ crate: z.object({ created_at: z.string() }).loose(), versions: z.array(z.object({ license: z.string().nullish() }).loose()).default([]) }).loose()

interface PublishedFacts {
  readonly firstPublished: Date | undefined
  readonly license: string | undefined
}

/** A JSON response, or undefined when the service says there's no such thing (404). */
type GetJson = (url: string) => Promise<unknown>

interface RegistryClient {
  /** Named in errors: the registry, or the service answering for it. */
  readonly service: string
  /** What the registry says about a package; undefined when it has never heard of it. */
  readonly facts: (name: string, getJson: GetJson) => Promise<PublishedFacts | undefined>
}

function singleRequest(service: string, url: (name: string) => string, read: (body: unknown) => PublishedFacts): RegistryClient {
  return {
    service,
    facts: async (name, getJson) => {
      const body = await getJson(url(name))
      return body === undefined ? undefined : read(body)
    },
  }
}

function npmLicenseText(license: z.infer<typeof npmLicenseSchema>): string | undefined {
  return typeof license === "string" ? license : license?.type
}

// A scope's leading @ stays as it is and its slash is encoded, as the registry expects. Everything
// else is encoded, because the name comes from the PR and must stay one path segment.
function npmPathFor(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
}

const REGISTRIES: Readonly<Record<Ecosystem, RegistryClient>> = {
  [Ecosystem.Npm]: singleRequest("npm", (name) => `https://registry.npmjs.org/${npmPathFor(name)}`, (body) => {
    const parsed = npmSchema.parse(body)
    const latest = parsed["dist-tags"]?.latest
    const latestLicense = latest === undefined ? undefined : parsed.versions?.[latest]?.license
    return { firstPublished: new Date(parsed.time.created), license: npmLicenseText(latestLicense) ?? npmLicenseText(parsed.license) }
  }),
  [Ecosystem.PyPI]: singleRequest("PyPI", (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`, (body) => {
    const { info, releases } = pypiSchema.parse(body)
    const times = Object.values(releases).flat().map((file) => new Date(file.upload_time_iso_8601).getTime())
    return { firstPublished: times.length === 0 ? undefined : new Date(Math.min(...times)), license: pypiLicense(info.license_expression, info.license, info.classifiers) }
  }),
  [Ecosystem.Crates]: singleRequest("crates.io", (name) => `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, (body) => {
    const parsed = cratesSchema.parse(body)
    return { firstPublished: new Date(parsed.crate.created_at), license: parsed.versions.at(0)?.license ?? undefined }
  }),
  // Go modules have no registry with an API for when a module first appeared or its licence;
  // deps.dev indexes the Go module proxy, and Maven Central and Google's Maven repository too.
  [Ecosystem.Go]: depsDevClient("go"),
  [Ecosystem.Maven]: depsDevClient("maven"),
}

const DEPS_DEV_SYSTEMS = "https://api.deps.dev/v3/systems"
const depsDevPackageSchema = z
  .object({
    versions: z.array(z.object({ versionKey: z.object({ version: z.string() }).loose(), publishedAt: z.string().optional(), isDefault: z.boolean().optional() }).loose()).default([]),
  })
  .loose()
const depsDevVersionSchema = z.object({ licenses: z.array(z.string()).default([]) }).loose()

// The package lists every version with when it was published; the licence is per version, so the
// default one, which deps.dev takes to be the latest release, is asked about.
function depsDevClient(system: string): RegistryClient {
  return {
    service: "deps.dev",
    facts: async (name, getJson) => {
      const packageUrl = `${DEPS_DEV_SYSTEMS}/${system}/packages/${encodeURIComponent(name)}`
      const body = await getJson(packageUrl)
      if (body === undefined) return undefined
      const { versions } = depsDevPackageSchema.parse(body)
      const times = versions.flatMap((version) => (version.publishedAt === undefined ? [] : [new Date(version.publishedAt).getTime()]))
      const current = versions.find((version) => version.isDefault === true) ?? versions.at(-1)
      const license = current === undefined ? undefined : depsDevLicense(await getJson(`${packageUrl}/versions/${encodeURIComponent(current.versionKey.version)}`))
      return { firstPublished: times.length === 0 ? undefined : new Date(Math.min(...times)), license }
    },
  }
}

// A pom can list several licences without saying whether they're alternatives, so all of them
// must be allowed: the cautious reading.
function depsDevLicense(body: unknown): string | undefined {
  if (body === undefined) return undefined
  const { licenses } = depsDevVersionSchema.parse(body)
  if (licenses.length <= 1) return licenses.at(0)
  return licenses.map((license) => `(${license})`).join(" AND ")
}

// A name reserved with no releases can't be installed, which to a reviewer is the same as missing.
export async function lookUpOnRegistry(ecosystem: Ecosystem, name: string): Promise<RegistryEntry> {
  const client = REGISTRIES[ecosystem]
  let facts: PublishedFacts | undefined
  try {
    facts = await client.facts(name, (url) => getJson(url, client.service))
  } catch (error: unknown) {
    if (error instanceof RegistryUnavailableError) throw error
    throw new RegistryUnavailableError(`${client.service} sent an unexpected answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  return facts?.firstPublished === undefined ? { status: RegistryStatus.Missing } : { status: RegistryStatus.Published, firstPublished: facts.firstPublished, license: facts.license }
}

async function getJson(url: string, service: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new RegistryUnavailableError(`could not reach ${service}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 404) return undefined
  if (!response.ok) throw new RegistryUnavailableError(`${service} responded ${response.status}`)
  return response.json()
}

export const LIVE_TRUST_SOURCES = (now: Date): TrustSources => ({ lookUp: lookUpOnRegistry, maliciousNames: findMaliciousPackages, now })
