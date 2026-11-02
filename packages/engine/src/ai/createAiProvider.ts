import { ANTHROPIC_BASE_URL_VARIABLE, anthropicBaseUrlFrom, AiProviderKind, baseUrlProblem } from "@walkdiff/review-model"
import type { AiSettings } from "@walkdiff/review-model"
import { AnthropicProvider } from "./anthropicProvider.ts"
import { AI_API_KEY_VARIABLE, OpenAiCompatibleProvider } from "./openAiCompatibleProvider.ts"
import { AiUnavailableError } from "./provider.ts"
import type { AiProvider } from "./provider.ts"

/** The provider a person chose. Keys come from the environment, so they are never stored. */
export function createAiProvider(ai: AiSettings, env: Readonly<Record<string, string | undefined>>): AiProvider {
  if (ai.provider === AiProviderKind.Anthropic) return anthropicProvider(ai.model, env)
  if (ai.baseUrl === null) throw new AiUnavailableError("no address is set for the AI provider")
  return new OpenAiCompatibleProvider({ model: ai.model, baseUrl: ai.baseUrl, apiKey: env[AI_API_KEY_VARIABLE] })
}

function anthropicProvider(model: string, env: Readonly<Record<string, string | undefined>>): AiProvider {
  const baseUrl = anthropicBaseUrlFrom(env)
  // The API key and the code would both travel unencrypted, as with any other provider's address.
  const problem = baseUrl === undefined ? undefined : baseUrlProblem(baseUrl)
  if (problem !== undefined) throw new AiUnavailableError(`${ANTHROPIC_BASE_URL_VARIABLE}: ${problem}`)
  return new AnthropicProvider(model, undefined, baseUrl)
}
