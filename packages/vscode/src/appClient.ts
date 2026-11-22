import { pullRequestListingSchema, REVIEW_MODEL_SCHEMA_VERSION, reviewModelSchema, reviewSummarySchema } from "@walkdiff/review-model"
import type { PullRequestListing, ReviewModel, ReviewSummary } from "@walkdiff/review-model"
import { z } from "zod"
import type { AppConnection } from "./connection.ts"

/** The app API version this extension was written for; see docs/app-api.md. */
export const SUPPORTED_API_VERSION = 1
const API_KEY_HEADER = "x-walkdiff-key"
const UNAUTHORIZED = 401
const NOT_FOUND = 404

const infoSchema = z.object({ apiVersion: z.number().int(), reportSchemaVersion: z.number().int(), version: z.string() })
const errorSchema = z.object({ error: z.string() })
const changedFileSchema = z.object({ text: z.string() })

export const FileSide = { Base: "base", Head: "head" } as const
export type FileSide = (typeof FileSide)[keyof typeof FileSide]

/**
 * The app has stopped, or restarted with a new key, so the connection file has to be read again.
 */
export class AppGoneError extends Error {
  override readonly name = "AppGoneError"
}

/** The app answered with an error, whose message is written to be shown as it is. */
export class AppRequestError extends Error {
  override readonly name = "AppRequestError"
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The app and this extension don't speak the same version of the API or the report. */
export class AppVersionError extends Error {
  override readonly name = "AppVersionError"
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** Calls a running Walkdiff app's API. Every answer is checked against the app's own schemas. */
export class AppClient {
  readonly #connection: AppConnection
  readonly #fetch: Fetch

  constructor(connection: AppConnection, fetchImpl: Fetch = fetch) {
    this.#connection = connection
    this.#fetch = fetchImpl
  }

  get version(): string {
    return this.#connection.version
  }

  /**
   * Checks that the app is there and speaks this extension's API and report versions.
   *
   * # Errors
   *
   * Throws an `AppVersionError` naming which side to update.
   */
  async checkVersions(): Promise<void> {
    const info = await this.#get("api/info", infoSchema)
    if (info.apiVersion !== SUPPORTED_API_VERSION) throw new AppVersionError(versionAdvice("API", info.apiVersion, SUPPORTED_API_VERSION, info.version))
    if (info.reportSchemaVersion !== REVIEW_MODEL_SCHEMA_VERSION) throw new AppVersionError(versionAdvice("report format", info.reportSchemaVersion, REVIEW_MODEL_SCHEMA_VERSION, info.version))
  }

  reviews(): Promise<ReviewSummary[]> {
    return this.#get("api/reviews", z.array(reviewSummarySchema))
  }

  addReview(url: string, ai: boolean): Promise<ReviewSummary> {
    return this.#send("POST", "api/reviews", { url, ai }, reviewSummarySchema)
  }

  analyzeAgain(id: number): Promise<ReviewSummary> {
    return this.#send("POST", `api/reviews/${id}/refresh`, undefined, reviewSummarySchema)
  }

  async remove(id: number): Promise<void> {
    await this.#send("DELETE", `api/reviews/${id}`, undefined, z.unknown())
  }

  report(id: number): Promise<ReviewModel> {
    return this.#get(`api/reviews/${id}/report`, reviewModelSchema)
  }

  /** A changed file's text at one side of the PR; undefined when it doesn't exist there, such as an added file at base. */
  async file(id: number, side: FileSide, path: string): Promise<string | undefined> {
    const query = new URLSearchParams({ side, path })
    try {
      return (await this.#get(`api/reviews/${id}/file?${query.toString()}`, changedFileSchema)).text
    } catch (error: unknown) {
      if (error instanceof AppRequestError && error.status === NOT_FOUND) return undefined
      throw error
    }
  }

  openPullRequests(remote: string, branch: string): Promise<PullRequestListing[]> {
    return this.#get(`api/pull-requests?${new URLSearchParams({ remote, branch }).toString()}`, z.array(pullRequestListingSchema))
  }

  reviewRequests(remote: string): Promise<PullRequestListing[]> {
    return this.#get(`api/review-requests?${new URLSearchParams({ remote }).toString()}`, z.array(pullRequestListingSchema))
  }

  /** The review's report page in the app, for a browser. */
  reportPageUrl(id: number): string {
    return new URL(`reviews/${id}`, this.#connection.url).toString()
  }

  #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.#send("GET", path, undefined, schema)
  }

  async #send<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    try {
      response = await this.#fetch(new URL(path, this.#connection.url).toString(), {
        method,
        headers: { [API_KEY_HEADER]: this.#connection.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error: unknown) {
      throw new AppGoneError("The Walkdiff app isn't running.", { cause: error })
    }
    if (response.status === UNAUTHORIZED) throw new AppGoneError("The Walkdiff app was restarted.")
    const json: unknown = await response.json()
    if (!response.ok) throw new AppRequestError(response.status, errorSchema.safeParse(json).data?.error ?? `The Walkdiff app answered ${response.status}.`)
    return schema.parse(json)
  }
}

function versionAdvice(what: string, appSpeaks: number, extensionSpeaks: number, appVersion: string): string {
  const update = appSpeaks > extensionSpeaks ? "Update the Walkdiff extension" : "Update Walkdiff (npx walkdiff@latest app)"
  return `The Walkdiff app (${appVersion}) uses ${what} version ${appSpeaks}, and this extension reads version ${extensionSpeaks}. ${update}.`
}
