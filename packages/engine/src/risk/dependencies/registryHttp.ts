// Shared by the lookups that ask public package registries about a package or one of its releases.

const REQUEST_TIMEOUT_MS = 15_000
// crates.io requires clients to identify themselves.
const USER_AGENT = "walkdiff (https://github.com/navasvarela/walkdiff)"

export class RegistryUnavailableError extends Error {
  override readonly name = "RegistryUnavailableError"
}

/** A JSON response, or undefined when the service says there's no such thing (404). */
export async function getRegistryJson(url: string, service: string): Promise<unknown> {
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

/**
 * A package name as one path segment of an npm registry URL. A scope's leading @ stays as it is and
 * its slash is encoded, as the registry expects. Everything else is encoded, because the name comes
 * from the PR.
 */
export function npmPackagePath(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
}
