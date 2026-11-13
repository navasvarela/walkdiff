import { LogLevel } from "@walkdiff/review-model"
import type { Log } from "@walkdiff/review-model"
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000

// GitHub's release downloads sometimes answer 502 or 504 for a few minutes, on any asset, while
// githubstatus.com shows nothing wrong. A blip costs a couple of seconds, and a longer outage gets
// half a minute, with every scanner waiting at once, before the scanner is reported as not run.
const RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const

const TOO_MANY_REQUESTS = 429
const FIRST_SERVER_ERROR = 500
const MS_PER_SECOND = 1000

export interface DownloadDependencies {
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>
  readonly wait: (ms: number) => Promise<void>
  readonly log: Log
}

const Outcome = { Done: "done", TryAgain: "tryAgain", Failed: "failed" } as const

type Attempt =
  | { readonly outcome: typeof Outcome.Done; readonly bytes: Buffer }
  | { readonly outcome: typeof Outcome.TryAgain; readonly problem: string }
  | { readonly outcome: typeof Outcome.Failed; readonly error: Error }

/**
 * Downloads `url`, trying again after a server error, a rate limit or a dropped connection.
 *
 * # Errors
 *
 * Rejects on any other HTTP error, on a timeout, or when the last try also fails.
 */
export async function downloadWithRetries(url: string, deps: DownloadDependencies): Promise<Buffer> {
  for (const delayMs of RETRY_DELAYS_MS) {
    const attempt = await downloadOnce(url, deps)
    if (attempt.outcome !== Outcome.TryAgain) return settled(attempt)
    deps.log(`Downloading ${url} failed (${attempt.problem}). Trying again in ${delayMs / MS_PER_SECOND} seconds.`, { level: LogLevel.Warn, fields: { url } })
    await deps.wait(delayMs)
  }
  const last = await downloadOnce(url, deps)
  if (last.outcome !== Outcome.TryAgain) return settled(last)
  throw new Error(`${url} failed ${RETRY_DELAYS_MS.length + 1} times, last with: ${last.problem}`)
}

function settled(attempt: Exclude<Attempt, { readonly outcome: typeof Outcome.TryAgain }>): Buffer {
  if (attempt.outcome === Outcome.Failed) throw attempt.error
  return attempt.bytes
}

async function downloadOnce(url: string, deps: DownloadDependencies): Promise<Attempt> {
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (isWorthRetrying(response.status)) return { outcome: Outcome.TryAgain, problem: `responded ${response.status}` }
    if (!response.ok) return { outcome: Outcome.Failed, error: new Error(`${url} responded ${response.status}`) }
    return { outcome: Outcome.Done, bytes: Buffer.from(await response.arrayBuffer()) }
  } catch (error: unknown) {
    return failedAttempt(error)
  }
}

function isWorthRetrying(status: number): boolean {
  return status === TOO_MANY_REQUESTS || status >= FIRST_SERVER_ERROR
}

// fetch rejects with a TypeError when the connection fails or drops mid-body, which is worth another
// try. A timeout isn't: each try already waited two minutes, and repeating that would hold up a
// review for several more.
function failedAttempt(error: unknown): Attempt {
  if (error instanceof TypeError) return { outcome: Outcome.TryAgain, problem: connectionProblem(error) }
  return { outcome: Outcome.Failed, error: error instanceof Error ? error : new Error(String(error)) }
}

function connectionProblem(error: TypeError): string {
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}
