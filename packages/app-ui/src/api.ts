import { aiConnectionResultSchema, approvalBlockedSchema, approveStackResultSchema, currentSettingsSchema, reviewSummarySchema, settingsViewSchema, stackViewSchema } from "@walkdiff/review-model"
import type { AcceptStackRequest, AddReviewRequest, ApprovalBlocked, ApproveStackRequest, ApproveStackResult, AiConnectionResult, AttachCoverageRequest, AppSettings, CurrentSettings, ReviewSummary, SettingsView, StackView } from "@walkdiff/review-model"

const API_KEY_HEADER = "X-Walkdiff-Key"

function apiKey(): string {
  return document.querySelector('meta[name="walkdiff-api-key"]')?.getAttribute("content") ?? ""
}

type RequestBody = AddReviewRequest | AppSettings | AttachCoverageRequest | AcceptStackRequest | ApproveStackRequest

interface Answer {
  readonly status: number
  readonly payload: unknown
}

async function send(path: string, method: string, body?: RequestBody): Promise<Answer> {
  const response = await fetch(path, {
    method,
    headers: { [API_KEY_HEADER]: apiKey(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, payload: await response.json() }
}

async function call(path: string, method: string, body?: RequestBody): Promise<unknown> {
  const { status, payload } = await send(path, method, body)
  if (status >= 400) throw new Error(errorMessage(payload) ?? `The app answered ${status}`)
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

const CONFLICT_STATUS = 409

export const ApprovalAnswerKind = { Ready: "ready", Done: "done", Blocked: "blocked" } as const

/** Either every approval was tried, each with its result, or a member stopped them all before any was posted. */
export type ApprovalAnswer = { readonly kind: typeof ApprovalAnswerKind.Done; readonly result: ApproveStackResult } | { readonly kind: typeof ApprovalAnswerKind.Blocked; readonly blocked: ApprovalBlocked }

/** Whether every member can be approved now, or which stop them all; nothing is posted. */
export type CheckAnswer = { readonly kind: typeof ApprovalAnswerKind.Ready } | { readonly kind: typeof ApprovalAnswerKind.Blocked; readonly blocked: ApprovalBlocked }

export async function checkStackApproval(id: number, request: ApproveStackRequest): Promise<CheckAnswer> {
  const answer = await send(`/api/stacks/${id}/approve/check`, "POST", request)
  if (answer.status === CONFLICT_STATUS) return { kind: ApprovalAnswerKind.Blocked, blocked: approvalBlockedSchema.parse(answer.payload) }
  if (answer.status >= 400) throw new Error(errorMessage(answer.payload) ?? `The app answered ${answer.status}`)
  return { kind: ApprovalAnswerKind.Ready }
}

export async function approveStack(id: number, request: ApproveStackRequest): Promise<ApprovalAnswer> {
  const answer = await send(`/api/stacks/${id}/approve`, "POST", request)
  if (answer.status === CONFLICT_STATUS) return { kind: ApprovalAnswerKind.Blocked, blocked: approvalBlockedSchema.parse(answer.payload) }
  if (answer.status >= 400) throw new Error(errorMessage(answer.payload) ?? `The app answered ${answer.status}`)
  return { kind: ApprovalAnswerKind.Done, result: approveStackResultSchema.parse(answer.payload) }
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
