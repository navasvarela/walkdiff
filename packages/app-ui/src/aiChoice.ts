import { useEffect, useState } from "react"
import { aiDestination } from "@walkdiff/review-model"
import type { AiDestination } from "@walkdiff/review-model"
import { loadCurrentSettings } from "./api.ts"

export interface AiChoice {
  /** Undefined until the settings load. */
  readonly destination: AiDestination | undefined
  readonly enabledByDefault: boolean
  readonly problem: string | undefined
}

/** Where AI review would send code, from the saved settings, so every AI box can say so. */
export function useAiChoice(): AiChoice {
  const [choice, setChoice] = useState<AiChoice>({ destination: undefined, enabledByDefault: false, problem: undefined })
  useEffect(() => {
    loadCurrentSettings()
      .then(({ settings, anthropicBaseUrl }) => setChoice({ destination: aiDestination(settings.ai, anthropicBaseUrl ?? undefined), enabledByDefault: settings.ai.enabledByDefault, problem: undefined }))
      .catch((error: unknown) => setChoice((current) => ({ ...current, problem: error instanceof Error ? error.message : String(error) })))
  }, [])
  return choice
}

export function aiOptionLabel(destination: AiDestination | undefined): string {
  if (destination === undefined) return "Include AI review"
  if (destination.isLocal) return "Include AI review (uses a model on this machine; your code stays here)"
  return `Include AI review (sends the changed code to ${destination.label}, and may cost money)`
}
