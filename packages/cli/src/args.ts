import { parseArgs } from "node:util"
import { isLogFormat, LOG_FORMAT_VARIABLE, LogFormat } from "./logging.ts"
import { AiProviderKind, aiSettingsSchema, DEFAULT_AI_MAX_INPUT_TOKENS, DEFAULT_AI_MODEL } from "@walkdiff/review-model"
import type { AiSettings } from "@walkdiff/review-model"

export const USAGE = `Usage:
  walkdiff review [pull-request-url] [options]
  walkdiff review --local [--base <ref>] [options]
  walkdiff comment --report <dir> --report-url <url>
  walkdiff app [options]
  walkdiff setup

review analyzes a GitHub pull request or GitLab merge request and serves a local report.
In GitHub Actions or a GitLab merge request pipeline the URL comes from the environment.

comment posts or updates a summary on the pull request, linking to the report.

app runs a local page where you add pull requests and keep track of several reviews.

setup installs the pinned security scanners Walkdiff runs, checking each against its hash. review
and app do this on their first run anyway, unless --offline.

Options:
  --local            Review the committed work on this repository's current branch, before
                     it has a pull request. Uncommitted changes are left out
  --base <ref>       With --local: the branch it will merge into (default: the remote's
                     default branch, else main or master)
  --out <dir>        Write the report here instead of the cache directory
  --port <number>    Port for the local server (review: 4318, or any free port; app: 4317)
  --no-serve         Write the report and exit without serving it
  --no-open          With app: don't open your browser
  --offline          Skip network checks (dependency vulnerability lookups in OSV)
  --ai               Add an AI review (reading order, intent check, questions); sends the
                     changed code to the model provider. Off by default.
  --ai-provider <p>  anthropic (default), or openai-compatible for OpenAI, other services and
                     local models such as Ollama
  --ai-base-url <u>  With openai-compatible: the address, such as http://localhost:11434/v1
  --ai-model <id>    Model for --ai (default: claude-opus-5-5)
  --ai-max-input-tokens <n>
                     Prompt budget for --ai (default: 40000); larger PRs are summarized
  --coverage <file>  With review: an LCOV or Cobertura report, to show whether changed lines
                     ran in tests
  --cache-dir <dir>  Where repositories and reports are cached (default: ~/.cache/walkdiff)
  --data-dir <dir>   With app: where the review list is stored (default: ~/.local/share/walkdiff)
  --report <dir>     With comment: the directory review wrote (--out)
  --report-url <url> With comment: where reviewers can open the report
  --log-format <f>   text (default), or json for one JSON object per line on stderr, with
                     time, level and msg, for CI and log collectors
  -h, --help         Show this help
  -v, --version      Show which Walkdiff this is

Environment:
  GITHUB_TOKEN, GH_TOKEN   Token for GitHub (required for private repositories)
  GITLAB_TOKEN             Token for GitLab (required for private projects)
  WALKDIFF_TRUSTED_GITHUB_HOSTS, WALKDIFF_TRUSTED_GITLAB_HOSTS
                           Comma-separated hosts besides github.com and gitlab.com that
                           may receive those tokens, such as git.acme.internal
  ANTHROPIC_API_KEY        Key for --ai with Anthropic (or an \`ant auth login\` profile)
  WALKDIFF_AI_API_KEY      Key for --ai with an OpenAI-compatible provider
  WALKDIFF_LOG_FORMAT      text or json, as --log-format, which takes precedence

Troubleshooting: https://github.com/navasvarela/walkdiff/blob/main/docs/troubleshooting.md`

const MAX_PORT = 65_535
// Fixed so the list page has an address worth bookmarking.
const DEFAULT_APP_PORT = 4317

export interface ReviewOptions {
  /** Undefined means: take it from the CI environment, unless `local` is set. */
  readonly url: string | undefined
  /** Set by --local: review the current branch here instead of a pull request. */
  readonly local: LocalReviewOptions | undefined
  readonly outDir: string | undefined
  /** Undefined prefers a fixed port, falling back to any free one. */
  readonly port: number | undefined
  readonly serve: boolean
  readonly cacheDir: string | undefined
  /** False when --offline: no package names or versions leave the machine. */
  readonly network: boolean
  /** A coverage report to read; undefined leaves test evidence to changed tests alone. */
  readonly coveragePath: string | undefined
  /** Undefined unless --ai: no code is sent to a model without it. */
  readonly ai: AiOptions | undefined
}

export type AiOptions = AiSettings

export interface LocalReviewOptions {
  /** What the branch will merge into; undefined finds the remote's default branch. */
  readonly baseRef: string | undefined
}

export interface CommentOptions {
  readonly reportDir: string
  readonly reportUrl: string
}

export interface AppOptions {
  readonly port: number
  readonly network: boolean
  readonly cacheDir: string | undefined
  readonly dataDir: string | undefined
  /** False when --no-open: leaves the browser alone. */
  readonly open: boolean
}

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "setup" }
  | { readonly kind: "app"; readonly options: AppOptions }
  | { readonly kind: "review"; readonly options: ReviewOptions }
  | { readonly kind: "comment"; readonly options: CommentOptions }

/** The command, and how to print what it does. */
export interface CommandLine {
  readonly command: Command
  readonly logFormat: LogFormat
}

export class UsageError extends Error {
  override readonly name = "UsageError"
}

export function parseCommandLine(argv: readonly string[], env: NodeJS.ProcessEnv): CommandLine {
  const { values, positionals } = parseOptions(argv)
  return { command: commandFrom(values, positionals), logFormat: parseLogFormat(values["log-format"], env) }
}

/**
 * The format for logs, from the option, else the environment, else text. Usable before the
 * command line has been read, so even an error in it can be logged as asked.
 */
export function logFormatFromEnvironment(env: NodeJS.ProcessEnv): LogFormat {
  const fromEnvironment = env[LOG_FORMAT_VARIABLE]
  return fromEnvironment !== undefined && isLogFormat(fromEnvironment) ? fromEnvironment : LogFormat.Text
}

function parseLogFormat(flag: string | undefined, env: NodeJS.ProcessEnv): LogFormat {
  const requested = flag ?? env[LOG_FORMAT_VARIABLE]
  if (requested === undefined) return LogFormat.Text
  if (!isLogFormat(requested)) throw new UsageError(`${flag === undefined ? LOG_FORMAT_VARIABLE : "--log-format"} must be text or json, got "${requested}"`)
  return requested
}

const OPTIONS = {
  out: { type: "string" },
  port: { type: "string" },
  serve: { type: "boolean", default: true },
  open: { type: "boolean", default: true },
  offline: { type: "boolean", default: false },
  ai: { type: "boolean", default: false },
  "ai-model": { type: "string" },
  "ai-provider": { type: "string" },
  "ai-base-url": { type: "string" },
  "ai-max-input-tokens": { type: "string" },
  "data-dir": { type: "string" },
  report: { type: "string" },
  "report-url": { type: "string" },
  "cache-dir": { type: "string" },
  coverage: { type: "string" },
  local: { type: "boolean", default: false },
  base: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
  "log-format": { type: "string" },
} as const

function parseOptions(argv: readonly string[]) {
  return parseArgs({ args: [...argv], allowPositionals: true, allowNegative: true, options: OPTIONS })
}

type ParsedValues = ReturnType<typeof parseOptions>["values"]

function commandFrom(values: ParsedValues, positionals: readonly string[]): Command {
  const [command, url, ...extra] = positionals
  if (values.version) {
    return { kind: "version" }
  }
  if (values.help || command === undefined) {
    return { kind: "help" }
  }
  if (command === "setup") {
    if (url !== undefined) throw new UsageError(`Unexpected arguments: ${[url, ...extra].join(" ")}`)
    return { kind: "setup" }
  }
  if (command === "comment") {
    return { kind: "comment", options: parseCommentOptions(values.report, values["report-url"]) }
  }
  if (command === "app") {
    return {
      kind: "app",
      options: {
        port: values.port === undefined ? DEFAULT_APP_PORT : parsePort(values.port),
        network: !values.offline,
        cacheDir: values["cache-dir"],
        dataDir: values["data-dir"],
        open: values.open,
      },
    }
  }
  if (command !== "review") {
    throw new UsageError(`Unknown command "${command}"`)
  }
  if (extra.length > 0) {
    throw new UsageError(`Unexpected arguments: ${extra.join(" ")}`)
  }

  if (values.local && url !== undefined) throw new UsageError("--local reviews this repository's branch, so it takes no pull request URL")
  if (values.base !== undefined && !values.local) throw new UsageError("--base only applies with --local")
  return {
    kind: "review",
    options: {
      url,
      local: values.local ? { baseRef: values.base } : undefined,
      outDir: values.out,
      port: values.port === undefined ? undefined : parsePort(values.port),
      serve: values.serve,
      cacheDir: values["cache-dir"],
      network: !values.offline,
      coveragePath: values.coverage,
      ai: values.ai ? parseAiOptions(values["ai-provider"], values["ai-model"], values["ai-base-url"], values["ai-max-input-tokens"]) : undefined,
    },
  }
}

const AI_PROVIDER_FLAGS: ReadonlyMap<string, AiProviderKind> = new Map([
  ["anthropic", AiProviderKind.Anthropic],
  ["openai-compatible", AiProviderKind.OpenAiCompatible],
])

function parseAiOptions(providerFlag: string | undefined, model: string | undefined, baseUrl: string | undefined, maxInputTokens: string | undefined): AiOptions {
  const provider = AI_PROVIDER_FLAGS.get(providerFlag ?? "anthropic")
  if (provider === undefined) throw new UsageError(`--ai-provider must be anthropic or openai-compatible, got "${providerFlag ?? ""}"`)
  if (provider === AiProviderKind.OpenAiCompatible && model === undefined) throw new UsageError("--ai-provider openai-compatible needs --ai-model")
  const parsed = aiSettingsSchema.safeParse({
    provider,
    model: model ?? DEFAULT_AI_MODEL,
    baseUrl: baseUrl ?? null,
    maxInputTokens: maxInputTokens === undefined ? DEFAULT_AI_MAX_INPUT_TOKENS : parsePositiveInteger(maxInputTokens, "--ai-max-input-tokens"),
    enabledByDefault: false,
  })
  if (!parsed.success) throw new UsageError(`--ai-base-url: ${parsed.error.issues.at(0)?.message ?? "invalid"}`)
  return parsed.data
}

function parseCommentOptions(reportDir: string | undefined, reportUrl: string | undefined): CommentOptions {
  if (reportDir === undefined || reportUrl === undefined) {
    throw new UsageError("comment needs both --report and --report-url")
  }
  if (!/^https?:\/\//.test(reportUrl)) {
    throw new UsageError(`--report-url must be an http or https URL, got "${reportUrl}"`)
  }
  return { reportDir, reportUrl }
}

function parsePositiveInteger(text: string, flag: string): number {
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`${flag} needs a positive whole number, got "${text}"`)
  }
  return value
}

function parsePort(text: string): number {
  const port = Number(text)
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new UsageError(`Invalid port "${text}"`)
  }
  return port
}
