import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { aiDestination, AiProviderKind } from "@walkdiff/review-model"
import type { AiDestination } from "@walkdiff/review-model"
import { rawAiOutputSchema } from "./output.ts"
import { AiUnavailableError } from "./provider.ts"
import type { AiCompletion, AiProvider } from "./provider.ts"

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5"
// The output is a structured review of a whole PR; 16k leaves ample room while keeping
// the non-streaming request well inside the SDK's HTTP timeout.
const MAX_OUTPUT_TOKENS = 16_000
// Reviewing code is intelligence-sensitive work; Opus 5.5 defaults to "medium".
const EFFORT = "high"
// If the model declines, the API reruns the same request on a fallback model it picks by
// refusal category, instead of failing the review.
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01"

/**
 * Calls Claude through the official SDK. The client is created on first use, so a missing
 * credential is reported as an unavailable review rather than failing the whole run.
 * Credentials resolve as the SDK does: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
 * `ant auth login` profile.
 */
export class AnthropicProvider implements AiProvider {
  readonly model: string
  readonly destination: AiDestination
  readonly #baseUrl: string | undefined
  #client: Anthropic | undefined

  constructor(model: string = DEFAULT_ANTHROPIC_MODEL, client?: Anthropic, baseUrl?: string) {
    this.model = model
    this.#client = client
    this.#baseUrl = baseUrl
    this.destination = aiDestination({ provider: AiProviderKind.Anthropic, model, baseUrl: null, maxInputTokens: 1, enabledByDefault: false }, baseUrl)
  }

  // Passed explicitly so the address that's reported is the one used, whatever the SDK would read.
  #clientForRequests(): Anthropic {
    this.#client ??= new Anthropic(this.#baseUrl === undefined ? {} : { baseURL: this.#baseUrl })
    return this.#client
  }

  /** Lists models, which sends no code and costs nothing. */
  async checkConnection(): Promise<void> {
    try {
      await this.#clientForRequests().models.list()
    } catch (error: unknown) {
      throw unavailableFrom(error, this.destination.label)
    }
  }

  async complete(system: string, prompt: string): Promise<AiCompletion> {
    try {
      const response = await this.#clientForRequests().beta.messages.parse({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        betas: [SERVER_SIDE_FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: EFFORT, format: betaZodOutputFormat(rawAiOutputSchema) },
        system,
        messages: [{ role: "user", content: prompt }],
      })
      if (response.stop_reason === "refusal") {
        throw new AiUnavailableError("the model declined to review this change")
      }
      if (response.stop_reason === "max_tokens") {
        throw new AiUnavailableError(`the response exceeded ${MAX_OUTPUT_TOKENS} tokens and was cut off`)
      }
      if (response.parsed_output === null) {
        throw new AiUnavailableError("the response did not match the expected review format")
      }
      return {
        output: response.parsed_output,
        model: response.model,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      }
    } catch (error: unknown) {
      throw unavailableFrom(error, this.destination.label)
    }
  }
}

// Most specific first: each SDK error class extends the ones below it.
function unavailableFrom(error: unknown, destination: string): unknown {
  if (error instanceof AiUnavailableError) return error
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiUnavailableError("Anthropic rejected the credentials; set ANTHROPIC_API_KEY or run `ant auth login`")
  }
  if (error instanceof Anthropic.RateLimitError) return new AiUnavailableError("rate limited by the Anthropic API; try again shortly")
  if (error instanceof Anthropic.APIConnectionError) return new AiUnavailableError(`could not reach ${destination}: ${error.message}`)
  if (error instanceof Anthropic.APIError) return new AiUnavailableError(`Anthropic API error ${error.status ?? ""}: ${error.message}`)
  if (error instanceof Anthropic.AnthropicError) return new AiUnavailableError(error.message)
  // The SDK reports a missing credential with a plain Error when it builds the request.
  // The AI review is optional, so any failure here becomes a reason shown in the report
  // instead of failing the whole run.
  if (error instanceof Error) return new AiUnavailableError(`the AI request failed: ${error.message}`)
  return error
}
