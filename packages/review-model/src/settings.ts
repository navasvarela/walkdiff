import { z } from "zod"

/** The optional checks a person can turn off. Built-in secret and risky API rules aren't among them. */
export const CheckId = {
  Semgrep: "semgrep",
  Gitleaks: "gitleaks",
  OsvScanner: "osvScanner",
  OsvDatabase: "osvDatabase",
  Ruff: "ruff",
  Oxlint: "oxlint",
  Jscpd: "jscpd",
  FunctionMetrics: "functionMetrics",
} as const
export type CheckId = (typeof CheckId)[keyof typeof CheckId]

export const AiProviderKind = { Anthropic: "anthropic", OpenAiCompatible: "openaiCompatible" } as const
export type AiProviderKind = (typeof AiProviderKind)[keyof typeof AiProviderKind]

export const DEFAULT_AI_MODEL = "claude-opus-5-5"
// About $0.16 of input on Claude Opus 5.5; enough for the full text of most PRs' changed units.
export const DEFAULT_AI_MAX_INPUT_TOKENS = 40_000

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname)
}

/** Why a provider's address can't be used, or undefined when it can. */
export function baseUrlProblem(text: string): string | undefined {
  if (!URL.canParse(text)) return "Enter a full address, such as https://api.example.com/v1"
  const url = new URL(text)
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackUrl(url))) return undefined
  return "Use https, because this address receives your code and API key. Plain http only works for a model on this machine"
}

export const aiSettingsSchema = z
  .object({
    provider: z.enum(AiProviderKind),
    model: z.string().trim().min(1, "Enter a model name"),
    /** Only for an OpenAI-compatible provider. */
    baseUrl: z.string().nullable(),
    maxInputTokens: z.number().int().positive(),
    enabledByDefault: z.boolean(),
  })
  .superRefine((ai, context) => {
    if (ai.provider !== AiProviderKind.OpenAiCompatible) return
    const problem = ai.baseUrl === null ? "Enter the provider's address" : baseUrlProblem(ai.baseUrl)
    if (problem !== undefined) context.addIssue({ code: "custom", path: ["baseUrl"], message: problem })
  })
export type AiSettings = z.infer<typeof aiSettingsSchema>

/** A person's own preferences. API keys are deliberately not here: they come from the environment. */
export const appSettingsSchema = z.object({
  disabledChecks: z.array(z.enum(CheckId)).readonly(),
  ai: aiSettingsSchema,
})
export type AppSettings = z.infer<typeof appSettingsSchema>

export const DEFAULT_APP_SETTINGS: AppSettings = {
  disabledChecks: [],
  ai: { provider: AiProviderKind.Anthropic, model: DEFAULT_AI_MODEL, baseUrl: null, maxInputTokens: DEFAULT_AI_MAX_INPUT_TOKENS, enabledByDefault: false },
}

export const LOCAL_AI_DESTINATION = "local"

/** Where AI review would send code: words for people, and names a team's rules can match. */
export interface AiDestination {
  readonly label: string
  readonly isLocal: boolean
  readonly ids: readonly string[]
}

export const ANTHROPIC_BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL"
const ANTHROPIC_API_HOST = "api.anthropic.com"

/**
 * The address Anthropic's SDK has been redirected to through the environment, if any. Only the
 * origin is kept, as a path or embedded credentials don't belong on a settings page.
 */
export function anthropicBaseUrlFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env[ANTHROPIC_BASE_URL_VARIABLE]?.trim()
  if (value === undefined || value === "" || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.hostname === ANTHROPIC_API_HOST ? undefined : url.origin
}

/**
 * `anthropicBaseUrl` is the address from `anthropicBaseUrlFrom`. It's never reported as local or as
 * Anthropic, even on this machine: a local proxy can forward code anywhere, and a team's rule
 * limiting AI to "anthropic" must not pass for a request going somewhere else.
 */
export function aiDestination(ai: AiSettings, anthropicBaseUrl?: string): AiDestination {
  if (ai.provider === AiProviderKind.Anthropic || ai.baseUrl === null) {
    if (anthropicBaseUrl === undefined) return { label: "Anthropic", isLocal: false, ids: [AiProviderKind.Anthropic] }
    const { host } = new URL(anthropicBaseUrl)
    return { label: `${host}, set by ${ANTHROPIC_BASE_URL_VARIABLE}`, isLocal: false, ids: [host] }
  }
  const url = new URL(ai.baseUrl)
  return isLoopbackUrl(url) ? { label: "a model on this machine", isLocal: true, ids: [url.host, LOCAL_AI_DESTINATION] } : { label: url.host, isLocal: false, ids: [url.host] }
}

/** What the settings page needs to know about one check. */
export const checkStatusSchema = z.object({
  id: z.enum(CheckId),
  name: z.string(),
  purpose: z.string(),
  /** Null for checks with nothing to install. */
  installed: z.boolean().nullable(),
  install: z.string().nullable(),
  /** What it sends and where; null when it stays on this machine. */
  sends: z.string().nullable(),
})
export type CheckStatus = z.infer<typeof checkStatusSchema>

/** What the review list needs to describe where AI review would send code. */
export const currentSettingsSchema = z.object({
  settings: appSettingsSchema,
  anthropicBaseUrl: z.string().nullable(),
})
export type CurrentSettings = z.infer<typeof currentSettingsSchema>

export const settingsViewSchema = z.object({
  settings: appSettingsSchema,
  checks: z.array(checkStatusSchema).readonly(),
  /** Whether a key is available, never the key itself. */
  aiKeys: z.object({ anthropic: z.boolean(), openaiCompatible: z.boolean() }),
  /** Where the environment redirects Anthropic's SDK; null when it doesn't. */
  anthropicBaseUrl: z.string().nullable(),
  /** True when the app was started with --offline. */
  offline: z.boolean(),
})
export type SettingsView = z.infer<typeof settingsViewSchema>

export const aiConnectionResultSchema = z.object({ ok: z.boolean(), message: z.string() })
export type AiConnectionResult = z.infer<typeof aiConnectionResultSchema>
