import { RiskSeverity } from "@walkdiff/review-model"
import { z } from "zod"
import type { PackageVersion } from "./packages.ts"

const OSV_API = "https://api.osv.dev/v1"
// OSV accepts up to 1000 queries per batch request.
const MAX_QUERIES_PER_BATCH = 1000
// Details are fetched one request per vulnerability; beyond this a PR is flagged in bulk.
const MAX_DETAILED_VULNERABILITIES = 50
const REQUEST_TIMEOUT_MS = 15_000

const batchResponseSchema = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).optional() })),
})

export const vulnerabilitySchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  database_specific: z.object({ severity: z.string().optional() }).loose().optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string(), ecosystem: z.string() }).optional(),
        ranges: z.array(z.object({ events: z.array(z.record(z.string(), z.string())) })).optional(),
      }),
    )
    .optional(),
})

export interface KnownVulnerability {
  readonly id: string
  readonly aliases: readonly string[]
  readonly summary: string | undefined
  readonly severity: RiskSeverity
  /** First version with the fix, when OSV records one for this package. */
  readonly fixedIn: string | undefined
}

export interface VulnerablePackage {
  readonly package: PackageVersion
  readonly vulnerability: KnownVulnerability
}

export class OsvUnavailableError extends Error {
  override readonly name = "OsvUnavailableError"
}

/** Looks up published vulnerabilities for exact package versions in the OSV database. */
export async function findVulnerabilities(packages: readonly PackageVersion[]): Promise<VulnerablePackage[]> {
  const affected: { package: PackageVersion; id: string }[] = []
  for (let start = 0; start < packages.length; start += MAX_QUERIES_PER_BATCH) {
    const batch = packages.slice(start, start + MAX_QUERIES_PER_BATCH)
    const response = await postJson(`${OSV_API}/querybatch`, {
      queries: batch.map((entry) => ({ package: { name: entry.name, ecosystem: entry.ecosystem }, version: entry.version })),
    })
    const { results } = batchResponseSchema.parse(response)
    results.forEach((result, index) => {
      const entry = batch.at(index)
      for (const vulnerability of result.vulns ?? []) {
        if (entry !== undefined) affected.push({ package: entry, id: vulnerability.id })
      }
    })
  }

  const ids = [...new Set(affected.map((entry) => entry.id))]
  const details = new Map<string, z.infer<typeof vulnerabilitySchema>>()
  for (const id of ids.slice(0, MAX_DETAILED_VULNERABILITIES)) {
    details.set(id, vulnerabilitySchema.parse(await getJson(`${OSV_API}/vulns/${encodeURIComponent(id)}`)))
  }

  return affected.map(({ package: entry, id }) => {
    const detail = details.get(id)
    return {
      package: entry,
      vulnerability: toKnownVulnerability(id, detail, entry),
    }
  })
}

// OSV's prefix for its malicious packages list, which describes a whole package or version as an attack.
const MALICIOUS_ADVISORY_PREFIX = "MAL-"

export function isMaliciousAdvisory(id: string): boolean {
  return id.startsWith(MALICIOUS_ADVISORY_PREFIX)
}

/**
 * Package name to its malicious advisory. Asks by name without a version, because a manifest often
 * declares a range, and a package that has ever been malicious shouldn't be newly added.
 */
export async function findMaliciousPackages(packages: readonly { readonly ecosystem: string; readonly name: string }[]): Promise<ReadonlyMap<string, string>> {
  const malicious = new Map<string, string>()
  for (let start = 0; start < packages.length; start += MAX_QUERIES_PER_BATCH) {
    const batch = packages.slice(start, start + MAX_QUERIES_PER_BATCH)
    const response = await postJson(`${OSV_API}/querybatch`, { queries: batch.map((entry) => ({ package: { name: entry.name, ecosystem: entry.ecosystem } })) })
    batchResponseSchema.parse(response).results.forEach((result, index) => {
      const advisory = result.vulns?.find((vulnerability) => isMaliciousAdvisory(vulnerability.id))
      const entry = batch.at(index)
      if (advisory !== undefined && entry !== undefined) malicious.set(entry.name, advisory.id)
    })
  }
  return malicious
}

export function toKnownVulnerability(id: string, detail: z.infer<typeof vulnerabilitySchema> | undefined, entry: PackageVersion): KnownVulnerability {
  return {
    id,
    aliases: detail?.aliases ?? [],
    summary: detail?.summary,
    // Often has no severity rating, and "medium" would badly undersell an attack.
    severity: isMaliciousAdvisory(id) ? RiskSeverity.High : severityOf(detail?.database_specific?.severity),
    fixedIn: fixedVersion(detail, entry),
  }
}

// GitHub advisories label severity LOW/MODERATE/HIGH/CRITICAL. Unknown counts as medium:
// a known vulnerability is never low until someone has rated it so.
function severityOf(label: string | undefined): RiskSeverity {
  switch (label?.toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return RiskSeverity.High
    case "LOW":
      return RiskSeverity.Low
    default:
      return RiskSeverity.Medium
  }
}

function fixedVersion(detail: z.infer<typeof vulnerabilitySchema> | undefined, entry: PackageVersion): string | undefined {
  const forPackage = detail?.affected?.find((candidate) => candidate.package?.name === entry.name)
  return forPackage?.ranges?.flatMap((range) => range.events).find((event) => event.fixed !== undefined)?.fixed
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  return request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

async function getJson(url: string): Promise<unknown> {
  return request(url, { method: "GET" })
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new OsvUnavailableError(`could not reach ${OSV_API}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new OsvUnavailableError(`${url} responded ${response.status}`)
  }
  return response.json()
}
