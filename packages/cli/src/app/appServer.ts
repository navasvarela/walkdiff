import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { gitHostFor, HostApiError, InvalidPullRequestUrlError, parsePullRequestUrl } from "@walkdiff/providers"
import type { GitHost, PullRequestRef } from "@walkdiff/providers"
import { AI_API_KEY_VARIABLE, AiUnavailableError, CoverageFileError, createAiProvider, describeChecks, firstExisting } from "@walkdiff/engine"
import { acceptStackRequestSchema, addReviewRequestSchema, approveStackRequestSchema, anthropicBaseUrlFrom, appSettingsSchema, attachCoverageRequestSchema, replySchema, resolveThreadSchema, submitReviewSchema } from "@walkdiff/review-model"
import { MemberCheck, ReportChange, ReviewStatus } from "@walkdiff/review-model"
import type { AiConnectionResult, SettingsView, CheckStatus, StackView } from "@walkdiff/review-model"
import { readHostTokens } from "../environment.ts"
import { REPORT_FILE_POLICY_TAG, REPORT_PAGE_FILE, writeReport } from "../report.ts"
import { addressOf, BASE_POLICY, listen, LOOPBACK_HOST, REPORT_PAGE_POLICY, respond, SECURITY_HEADERS } from "../server.ts"
import { attachCoverage } from "./attachCoverage.ts"
import type { ReportWriter } from "./attachCoverage.ts"
import type { ReviewService } from "./reviewService.ts"
import type { ReviewStore } from "./reviewStore.ts"
import { ApproveKind, approveStack } from "./approveStack.ts"
import { readStackView } from "./stackStatus.ts"
import type { HostResolver } from "./stackStatus.ts"

export type { HostResolver } from "./stackStatus.ts"

export const API_KEY_HEADER = "x-walkdiff-key"
const API_KEY_META = "walkdiff-api-key"
const HOME_META = "walkdiff-home"
const REVIEW_ID_META = "walkdiff-review-id"
const HOME_PATH = "/"
// Large enough for a review with many comments.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
// A whole monorepo's LCOV runs to tens of megabytes; only the changed lines are kept from it.
const MAX_COVERAGE_UPLOAD_BYTES = 128 * 1024 * 1024
const API_KEY_BYTES = 32

// The UI's build sits at a fixed place in the workspace, as the CLI runs from source.
const APP_UI_DIST = firstExisting([resolve(import.meta.dirname, "app-ui"), resolve(import.meta.dirname, "../../../app-ui/dist")])

// Pages show text and code from PRs, and the API behind them can act with the user's token.
const APP_PAGE_POLICY = `${BASE_POLICY}; script-src 'self'; style-src 'self'`

const UNEXPECTED_ERROR = "Something went wrong. The terminal running Walkdiff has the details."

export interface AppServer {
  readonly url: string
  close(): Promise<void>
}

interface AppContext {
  readonly store: ReviewStore
  readonly service: ReviewService
  readonly apiKey: string
  readonly allowedHosts: ReadonlySet<string>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly offline: boolean
  readonly hostFor: HostResolver
  readonly writeReport: ReportWriter
  readonly describeChecks: () => Promise<CheckStatus[]>
}

export class AppPortInUseError extends Error {
  override readonly name = "AppPortInUseError"

  constructor(port: number) {
    super(`Port ${port} is in use. If the app is already running, open http://${LOOPBACK_HOST}:${port}/, or pick another with --port.`)
  }
}

export interface AppServerOptions {
  readonly port: number
  readonly log: (message: string) => void
  /** Tests fix the key; otherwise a new one is created for this run. */
  readonly apiKey?: string
  /** For the settings page: whether API keys are available. Keys never leave the server. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly offline?: boolean
  /** How to reach a PR's host, with its token. Tests replace it. */
  readonly hostFor?: HostResolver
  /** How to rewrite a report. Tests replace it, since the real one needs the built UI. */
  readonly writeReport?: ReportWriter
  /**
   * Lists the optional checks and whether each can run. Tests replace it: the real one starts every
   * scanner, which under load can outlast a test's time limit.
   */
  readonly describeChecks?: () => Promise<CheckStatus[]>
}

/** Serves the review list, the reports and their API, on the loopback interface only. */
export async function startAppServer(store: ReviewStore, service: ReviewService, options: AppServerOptions): Promise<AppServer> {
  const { port, log, apiKey = newApiKey(), env = {}, offline = false } = options
  const hostFor = options.hostFor ?? ((ref: PullRequestRef): Promise<GitHost> => Promise.resolve(gitHostFor(ref, readHostTokens(env))))
  const allowedHosts = new Set<string>()
  const context: AppContext = { store, service, apiKey, allowedHosts, env, offline, hostFor, writeReport: options.writeReport ?? writeReport, describeChecks: options.describeChecks ?? (() => describeChecks()) }
  const server = createServer((request, response) => {
    handle(request, response, context).catch((error: unknown) => {
      // Details such as file paths go to the terminal, not to whatever made the request.
      log(`The app could not answer ${request.method ?? ""} ${request.url ?? ""}: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(response, 500, { error: UNEXPECTED_ERROR })
    })
  })
  await listenOn(server, port)
  const bound = addressOf(server).port
  allowedHosts.add(`${LOOPBACK_HOST}:${bound}`)
  allowedHosts.add(`localhost:${bound}`)
  return {
    url: `http://${LOOPBACK_HOST}:${bound}/`,
    close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
  }
}

// Created fresh each run and never stored, so it lasts only as long as the process.
function newApiKey(): string {
  return randomBytes(API_KEY_BYTES).toString("hex")
}

async function listenOn(server: Server, port: number): Promise<void> {
  try {
    await listen(server, port)
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") throw new AppPortInUseError(port)
    throw error
  }
}

async function handle(request: IncomingMessage, response: ServerResponse, context: AppContext): Promise<void> {
  // A web page can point its own domain at 127.0.0.1 to read this server as if same-origin.
  // Refusing unknown Host headers closes that, for pages (which carry the key) and the API.
  if (!context.allowedHosts.has(request.headers.host ?? "")) {
    sendText(response, 403, "Forbidden")
    return
  }
  const { pathname } = new URL(request.url ?? "/", "http://localhost")
  if (pathname.startsWith("/api/")) {
    await handleApi(request, response, pathname, context)
    return
  }
  const reportId = /^\/reviews\/(\d+)\/?$/.exec(pathname)?.[1]
  if (reportId !== undefined) {
    await sendReportPage(response, Number(reportId), context)
    return
  }
  await sendAppFile(response, pathname, context)
}

async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string, context: AppContext): Promise<void> {
  // A custom header cannot be sent cross-origin without a preflight, which this server never
  // approves, so a key mismatch also stops other sites from triggering actions.
  if (request.headers[API_KEY_HEADER] !== context.apiKey) {
    sendJson(response, 401, { error: "The app was restarted. Reload this page." })
    return
  }
  const method = request.method ?? "GET"
  if (pathname === "/api/reviews") {
    if (method === "GET") {
      sendJson(response, 200, context.service.list())
      return
    }
    if (method === "POST") {
      await addReview(request, response, context)
      return
    }
  }
  if (pathname === "/api/settings") {
    if (method === "GET") {
      sendJson(response, 200, await settingsView(context))
      return
    }
    if (method === "PUT") {
      await saveSettings(request, response, context)
      return
    }
  }
  // Separate from the full view, which is slow because it asks every scanner for its version.
  if (pathname === "/api/settings/current" && method === "GET") {
    sendJson(response, 200, { settings: context.store.getSettings(), anthropicBaseUrl: anthropicBaseUrlFrom(context.env) ?? null })
    return
  }
  if (pathname === "/api/settings/test-ai" && method === "POST") {
    sendJson(response, 200, await testAiConnection(context))
    return
  }
  const coverage = /^\/api\/reviews\/(\d+)\/coverage$/.exec(pathname)
  if (coverage !== null && method === "POST") {
    await attachCoverageReports(request, response, Number(coverage[1]), context)
    return
  }
  const reviewStack = /^\/api\/reviews\/(\d+)\/stack$/.exec(pathname)
  if (reviewStack !== null) {
    await handleStackOffer(request, response, Number(reviewStack[1]), context)
    return
  }
  const stack = /^\/api\/stacks\/(\d+)$/.exec(pathname)
  if (stack !== null && (method === "GET" || method === "DELETE")) {
    await handleStack(response, method, Number(stack[1]), context)
    return
  }
  const stackApprove = /^\/api\/stacks\/(\d+)\/approve$/.exec(pathname)
  if (stackApprove !== null && method === "POST") {
    await approveAll(request, response, Number(stackApprove[1]), context)
    return
  }
  const stackRefresh = /^\/api\/stacks\/(\d+)\/refresh$/.exec(pathname)
  if (stackRefresh !== null && method === "POST") {
    await refreshStack(response, Number(stackRefresh[1]), context)
    return
  }
  const action = /^\/api\/reviews\/(\d+)\/(conversation|submit)$/.exec(pathname)
  if (action !== null) {
    await handleReviewAction(request, response, Number(action[1]), action[2] ?? "", context)
    return
  }
  const thread = /^\/api\/reviews\/(\d+)\/threads\/([^/]+)\/(reply|resolve)$/.exec(pathname)
  if (thread !== null && method === "POST") {
    await handleThreadAction(request, response, Number(thread[1]), decodeURIComponent(thread[2] ?? ""), thread[3] ?? "", context)
    return
  }
  const match = /^\/api\/reviews\/(\d+)(\/refresh)?$/.exec(pathname)
  const id = Number(match?.[1])
  if (match !== null && method === "POST" && match[2] !== undefined) {
    const review = context.service.refresh(id)
    sendJson(response, review === undefined ? 404 : 202, review ?? { error: "No such review" })
    return
  }
  if (match !== null && method === "DELETE" && match[2] === undefined) {
    context.service.remove(id)
    sendJson(response, 200, {})
    return
  }
  sendJson(response, 404, { error: "Not found" })
}

/** POST accepts the stack found from a review, DELETE turns it down for now. */
async function handleStackOffer(request: IncomingMessage, response: ServerResponse, id: number, context: AppContext): Promise<void> {
  if (request.method === "DELETE") {
    const review = context.service.dismissStackOffer(id)
    sendJson(response, review === undefined ? 404 : 200, review ?? { error: "No such review" })
    return
  }
  if (request.method !== "POST") {
    sendJson(response, 404, { error: "Not found" })
    return
  }
  const parsed = acceptStackRequestSchema.safeParse(await readJsonBody(request))
  if (!parsed.success) {
    sendJson(response, 400, { error: "Expected whether to include AI review" })
    return
  }
  const review = context.service.acceptStack(id, parsed.data)
  sendJson(response, review === undefined ? 404 : 202, review ?? { error: "No such review" })
}

/** GET reads a stack's state from the host; DELETE ungroups it, keeping the reviews. */
async function handleStack(response: ServerResponse, method: "GET" | "DELETE", id: number, context: AppContext): Promise<void> {
  if (method === "DELETE") {
    sendJson(response, context.service.ungroup(id) ? 200 : 404, {})
    return
  }
  const view = await readStackView(context.store, id, context.hostFor)
  sendJson(response, view === undefined ? 404 : 200, view ?? { error: "No such stack" })
}

/** Reads the stack's state from the host, and re-runs the members it shows are out of date. */
async function refreshStack(response: ServerResponse, id: number, context: AppContext): Promise<void> {
  const view = await readStackView(context.store, id, context.hostFor)
  if (view === undefined) {
    sendJson(response, 404, { error: "No such stack" })
    return
  }
  refreshChanged(view, context)
  sendJson(response, 202, view)
}

/** Posts an approval to each member asked for, after checking every one is still what the reviewer saw. */
async function approveAll(request: IncomingMessage, response: ServerResponse, id: number, context: AppContext): Promise<void> {
  const parsed = approveStackRequestSchema.safeParse(await readJsonBody(request))
  if (!parsed.success) {
    sendJson(response, 400, { error: parsed.error.issues.at(0)?.message ?? "This approval isn't valid" })
    return
  }
  const result = await approveStack(context.store, id, parsed.data, context.hostFor)
  switch (result.kind) {
    case ApproveKind.NoStack:
      sendJson(response, 404, { error: "No such stack" })
      return
    case ApproveKind.Blocked:
      sendJson(response, 409, { error: "Nothing was posted: some PRs aren't as you saw them.", blocked: result.blocked })
      return
    case ApproveKind.Done:
      sendJson(response, 200, { results: result.results })
  }
}

/** Re-runs the members whose reports are out of date, leaving alone those already waiting or running. */
function refreshChanged(view: StackView, context: AppContext): void {
  for (const member of view.members) {
    if (member.check !== MemberCheck.Checked || member.reportChange === ReportChange.None) continue
    const status = context.store.get(member.reviewId)?.status
    if (status !== ReviewStatus.Queued && status !== ReviewStatus.Analyzing) context.service.refresh(member.reviewId)
  }
}

async function settingsView(context: AppContext): Promise<SettingsView> {
  return {
    settings: context.store.getSettings(),
    checks: await context.describeChecks(),
    aiKeys: { anthropic: nonEmpty(context.env.ANTHROPIC_API_KEY), openaiCompatible: nonEmpty(context.env[AI_API_KEY_VARIABLE]) },
    anthropicBaseUrl: anthropicBaseUrlFrom(context.env) ?? null,
    offline: context.offline,
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== ""
}

async function saveSettings(request: IncomingMessage, response: ServerResponse, context: AppContext): Promise<void> {
  const parsed = appSettingsSchema.safeParse(await readJsonBody(request))
  if (!parsed.success) {
    sendJson(response, 400, { error: parsed.error.issues.at(0)?.message ?? "These settings aren't valid" })
    return
  }
  context.store.saveSettings(parsed.data)
  sendJson(response, 200, await settingsView(context))
}

/** Sends no code. Tries the saved settings, so what's tested is what a review would use. */
async function testAiConnection(context: AppContext): Promise<AiConnectionResult> {
  const provider = createAiProvider(context.store.getSettings().ai, context.env)
  try {
    await provider.checkConnection()
    return { ok: true, message: `Connected to ${provider.destination.label}. No code was sent.` }
  } catch (error: unknown) {
    if (!(error instanceof AiUnavailableError)) throw error
    return { ok: false, message: error.message }
  }
}

/** The host comes from the saved review, never the request, so a page can't aim a token elsewhere. */
async function attachCoverageReports(request: IncomingMessage, response: ServerResponse, id: number, context: AppContext): Promise<void> {
  const parsed = attachCoverageRequestSchema.safeParse(await readJsonBody(request, MAX_COVERAGE_UPLOAD_BYTES))
  if (!parsed.success) {
    sendJson(response, 400, { error: "Those files are too large to read, or weren't sent correctly." })
    return
  }
  try {
    const review = await attachCoverage(context.store, id, parsed.data.reports, context.writeReport)
    sendJson(response, review === undefined ? 404 : 201, review ?? { error: "This review has no report yet" })
  } catch (error: unknown) {
    if (!(error instanceof CoverageFileError)) throw error
    sendJson(response, 400, { error: error.message })
  }
}

async function hostOf(id: number, context: AppContext): Promise<GitHost | undefined> {
  const review = context.store.get(id)
  return review === undefined ? undefined : context.hostFor(parsePullRequestUrl(review.url))
}

async function handleReviewAction(request: IncomingMessage, response: ServerResponse, id: number, action: string, context: AppContext): Promise<void> {
  const host = await hostOf(id, context)
  if (host === undefined) {
    sendJson(response, 404, { error: "No such review" })
    return
  }
  await answeringHostFailures(response, async () => {
    if (action === "conversation" && request.method === "GET") {
      sendJson(response, 200, await host.fetchConversation())
    } else if (action === "submit" && request.method === "POST") {
      await submitReview(request, response, host)
    } else {
      sendJson(response, 404, { error: "Not found" })
    }
  })
}

async function submitReview(request: IncomingMessage, response: ServerResponse, host: GitHost): Promise<void> {
  const parsed = submitReviewSchema.safeParse(await readJsonBody(request))
  if (!parsed.success) {
    sendJson(response, 400, { error: parsed.error.issues.at(0)?.message ?? "This review isn't valid" })
    return
  }
  // A review only speaks for the code that was read, so approving must not reach newer commits.
  if ((await host.fetchStatus()).headSha !== parsed.data.headSha) {
    sendJson(response, 409, { error: "This PR has new commits since this report was made. Nothing was posted. Refresh the review, and your comments will still be here." })
    return
  }
  sendJson(response, 201, await host.submitReview(parsed.data))
}

async function handleThreadAction(request: IncomingMessage, response: ServerResponse, id: number, threadId: string, action: string, context: AppContext): Promise<void> {
  const host = await hostOf(id, context)
  if (host === undefined) {
    sendJson(response, 404, { error: "No such review" })
    return
  }
  const body = await readJsonBody(request)
  await answeringHostFailures(response, async () => {
    if (action === "reply") {
      const reply = replySchema.safeParse(body)
      if (!reply.success) return sendJson(response, 400, { error: "Write a reply first" })
      await host.replyToThread(threadId, reply.data.body)
    } else {
      const resolve = resolveThreadSchema.safeParse(body)
      if (!resolve.success) return sendJson(response, 400, { error: "Expected whether to resolve the thread" })
      await host.setThreadResolved(threadId, resolve.data.resolved)
    }
    sendJson(response, 200, {})
  })
}

/** A refusal from the host is news for the reviewer, such as GitHub not letting you approve your own PR. */
async function answeringHostFailures(response: ServerResponse, act: () => Promise<void>): Promise<void> {
  try {
    await act()
  } catch (error: unknown) {
    if (!(error instanceof HostApiError)) throw error
    sendJson(response, 502, { error: error.message })
  }
}

async function addReview(request: IncomingMessage, response: ServerResponse, context: AppContext): Promise<void> {
  const body = await readJsonBody(request)
  const parsed = addReviewRequestSchema.safeParse(body)
  if (!parsed.success) {
    sendJson(response, 400, { error: "Expected a pull request URL" })
    return
  }
  try {
    sendJson(response, 202, context.service.add(parsed.data))
  } catch (error: unknown) {
    if (!(error instanceof InvalidPullRequestUrlError)) throw error
    sendJson(response, 400, { error: error.message })
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number = MAX_REQUEST_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

async function sendReportPage(response: ServerResponse, id: number, context: AppContext): Promise<void> {
  const reportDir = context.store.reportDirOf(id)
  if (reportDir === undefined) {
    sendText(response, 404, "This review has no report yet.")
    return
  }
  const page = await readReportPage(reportDir)
  if (page === undefined) {
    sendText(response, 404, "This report is no longer on disk. Refresh the review to create it again.")
    return
  }
  sendHtml(response, withReviewId(withMeta(page.replace(REPORT_FILE_POLICY_TAG, ""), context.apiKey), id), REPORT_PAGE_POLICY)
}

/** Undefined when the file is gone, which happens after the cache folder is cleared. */
async function readReportPage(reportDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(reportDir, REPORT_PAGE_FILE), "utf8")
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

async function sendAppFile(response: ServerResponse, pathname: string, context: AppContext): Promise<void> {
  const file = await respond(APP_UI_DIST, pathname)
  if (pathname !== HOME_PATH) {
    response.writeHead(file.status, { "Content-Type": file.contentType, ...SECURITY_HEADERS })
    response.end(file.body)
    return
  }
  if (file.status !== 200) {
    sendText(response, 500, "The app UI has not been built. Run: pnpm build:ui")
    return
  }
  sendHtml(response, withMeta(file.body.toString(), context.apiKey), APP_PAGE_POLICY)
}

/**
 * Hands the page its API key and the way home. Added per response, never written to disk,
 * so a report file saved or uploaded elsewhere holds neither.
 */
export function withMeta(page: string, apiKey: string): string {
  const meta = `<meta name="${API_KEY_META}" content="${apiKey}"><meta name="${HOME_META}" content="${HOME_PATH}">`
  return page.replace("</head>", () => `${meta}</head>`)
}

function withReviewId(page: string, id: number): string {
  return page.replace("</head>", () => `<meta name="${REVIEW_ID_META}" content="${id}"></head>`)
}

function sendHtml(response: ServerResponse, html: string, policy: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy, ...SECURITY_HEADERS })
  response.end(html)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS })
  response.end(JSON.stringify(body))
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS })
  response.end(body)
}
