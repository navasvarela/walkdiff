import { aiConnectionResultSchema, currentSettingsSchema, reviewSummarySchema, settingsViewSchema, stackViewSchema } from "@walkdiff/review-model"
import type { AcceptStackRequest, AddReviewRequest, AiConnectionResult, AttachCoverageRequest, AppSettings, CurrentSettings, ReviewSummary, SettingsView, StackView } from "@walkdiff/review-model"

const API_KEY_HEADER = "X-Walkdiff-Key"

function apiKey(): string {
  return document.querySelector('meta[name="walkdiff-api-key"]')?.getAttribute("content") ?? ""
}

async function call(path: string, method: string, body?: AddReviewRequest | AppSettings | AttachCoverageRequest | AcceptStackRequest): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { [API_KEY_HEADER]: apiKey(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `The app answered ${response.status}`)
  }
  return payload
}

function errorMessage(payload: unknown): string | undefined {
  return typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : undefined
}

export async function listReviews(): Promise<readonly ReviewSummary[]> {
  return reviewSummarySchema.array().parse(await call("/api/reviews", "GET"))
}

export async function addReview(request: AddReviewRequest): Promise<void> {
  await call("/api/reviews", "POST", request)
}

export async function refreshReview(id: number): Promise<void> {
  await call(`/api/reviews/${id}/refresh`, "POST")
}

export async function attachCoverage(id: number, files: readonly File[]): Promise<void> {
  const reports = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })))
  await call(`/api/reviews/${id}/coverage`, "POST", { reports })
}

export async function removeReview(id: number): Promise<void> {
  await call(`/api/reviews/${id}`, "DELETE")
}

/** Groups the review with the rest of its stack, adding those not on the list with this AI choice. */
export async function acceptStack(id: number, request: AcceptStackRequest): Promise<void> {
  await call(`/api/reviews/${id}/stack`, "POST", request)
}

export async function dismissStackOffer(id: number): Promise<void> {
  await call(`/api/reviews/${id}/stack`, "DELETE")
}

/** Asks each member's host, so it takes a moment. */
export async function loadStack(id: number): Promise<StackView> {
  return stackViewSchema.parse(await call(`/api/stacks/${id}`, "GET"))
}

/** Re-runs the members whose reports are out of date, and answers with the stack as it was found. */
export async function refreshStack(id: number): Promise<StackView> {
  return stackViewSchema.parse(await call(`/api/stacks/${id}/refresh`, "POST"))
}

export async function ungroupStack(id: number): Promise<void> {
  await call(`/api/stacks/${id}`, "DELETE")
}

export async function loadSettings(): Promise<SettingsView> {
  return settingsViewSchema.parse(await call("/api/settings", "GET"))
}

export async function loadCurrentSettings(): Promise<CurrentSettings> {
  return currentSettingsSchema.parse(await call("/api/settings/current", "GET"))
}

export async function saveSettings(settings: AppSettings): Promise<SettingsView> {
  return settingsViewSchema.parse(await call("/api/settings", "PUT", settings))
}

export async function testAiConnection(): Promise<AiConnectionResult> {
  return aiConnectionResultSchema.parse(await call("/api/settings/test-ai", "POST"))
}
