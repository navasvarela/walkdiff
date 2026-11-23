import { REPORT_SAVED_STATE_ELEMENT_ID, REPORT_TRANSPORT_META, ReportTransport, reportReplySchema, savedReportStateSchema } from "@walkdiff/review-model"
import type { ReportMessage, ReportRequestMethod } from "@walkdiff/review-model"

const API_KEY_HEADER = "X-Walkdiff-Key"
const API_KEY_META = "walkdiff-api-key"
const REVIEW_ID_META = "walkdiff-review-id"
const HOME_META = "walkdiff-home"

/**
 * Where the report runs, and so how it reaches the app and keeps the reviewer's progress:
 *
 * - a file or CI artifact: read-only, with progress in the browser;
 * - the local app in a browser: calls the app with the key the app put on the page;
 * - an editor's panel, such as VS Code's: posts each call to the editor, which holds the key and
 *   makes it, and keeps progress there, since a panel's own storage doesn't last.
 */
export interface ReportHost {
  /** The review's id in the app; undefined when the report isn't open from the app. */
  readonly reviewId: number | undefined
  /** Calls the app's API, by its path from `/api/`, and resolves to its JSON. */
  call(method: ReportRequestMethod, path: string, body?: unknown): Promise<unknown>
  readStorage(key: string): string | null
  writeStorage(key: string, value: string): void
  /** The app's review list, for a link home; undefined where there's no such page. */
  homeUrl(): string | undefined
  /** Where a link to another review goes. */
  reviewUrl(id: number): string
  /** Opens another review itself, for hosts a link can't reach; false to follow the link instead. */
  openReview(id: number): boolean
}

function meta(name: string): string | null {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null
}

function reviewIdFromPage(): number | undefined {
  const id = Number(meta(REVIEW_ID_META))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

function errorFrom(status: number, payload: unknown): Error {
  return new Error(typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : `The app answered ${status}`)
}

/** In a browser: the local app's own page, or a report opened from a file or CI, which has no key. */
function browserHost(): ReportHost {
  const apiKey = meta(API_KEY_META)
  const reviewId = reviewIdFromPage()
  return {
    reviewId: apiKey === null ? undefined : reviewId,
    async call(method, path, body) {
      const response = await fetch(path, {
        method,
        headers: { [API_KEY_HEADER]: apiKey ?? "", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) throw errorFrom(response.status, payload)
      return payload
    },
    readStorage(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // Progress is a convenience: without storage it lasts until the page closes.
      }
    },
    homeUrl: () => meta(HOME_META) ?? undefined,
    reviewUrl: (id) => `/reviews/${id}/`,
    openReview: () => false,
  }
}

interface EditorApi {
  postMessage(message: ReportMessage): void
}

function isEditorApi(value: unknown): value is EditorApi {
  return typeof value === "object" && value !== null && "postMessage" in value && typeof value.postMessage === "function"
}

/** VS Code gives a panel's page this function, once, to post messages to the extension. */
function editorApi(): EditorApi | undefined {
  const acquire: unknown = Reflect.get(globalThis, "acquireVsCodeApi")
  if (typeof acquire !== "function") return undefined
  const api: unknown = acquire()
  return isEditorApi(api) ? api : undefined
}

function savedStateFromPage(): Map<string, string> {
  const text = document.getElementById(REPORT_SAVED_STATE_ELEMENT_ID)?.textContent ?? ""
  try {
    return new Map(Object.entries(savedReportStateSchema.parse(JSON.parse(text))))
  } catch {
    return new Map()
  }
}

function editorHost(api: EditorApi): ReportHost {
  const saved = savedStateFromPage()
  const pending = new Map<number, { readonly resolve: (body: unknown) => void; readonly reject: (error: Error) => void }>()
  let nextId = 0
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const reply = reportReplySchema.safeParse(event.data)
    if (!reply.success) return
    const waiting = pending.get(reply.data.id)
    if (waiting === undefined) return
    pending.delete(reply.data.id)
    const { status, body } = reply.data
    if (status >= 200 && status < 300) waiting.resolve(body)
    else waiting.reject(errorFrom(status, body))
  })
  return {
    reviewId: reviewIdFromPage(),
    call: (method, path, body) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        api.postMessage({ type: "request", id, method, path, ...(body === undefined ? {} : { body }) })
      }),
    readStorage: (key) => saved.get(key) ?? null,
    writeStorage(key, value) {
      saved.set(key, value)
      api.postMessage({ type: "save", key, value })
    },
    homeUrl: () => undefined,
    reviewUrl: (id) => `#review-${id}`,
    openReview(id) {
      api.postMessage({ type: "openReview", reviewId: id })
      return true
    },
  }
}

function currentHost(): ReportHost {
  const api = meta(REPORT_TRANSPORT_META) === ReportTransport.Editor ? editorApi() : undefined
  return api === undefined ? browserHost() : editorHost(api)
}

/** Chosen once, as the page loads: an editor's API can only be acquired once. */
export const host: ReportHost = currentHost()
