import { matchesGlob } from "node:path"
import { RiskSeverity } from "@walkdiff/review-model"
import type { CommitSha } from "@walkdiff/review-model"
import { z } from "zod"
import { readBlobs } from "../blobs.ts"

/**
 * Per-repository settings. Callers read them from the merge base, not the PR's head: a PR
 * must not be able to loosen the rules it is judged by, for example by ignoring every path.
 */
export const WALKDIFF_CONFIG_PATH = ".walkdiff.json"
/**
 * The name before the project was renamed. It stays honoured because it can hold rules that
 * protect code, such as forbidding AI review: ignoring it would silently send that code away.
 */
const LEGACY_CONFIG_PATH = ".lens.json"

// Semgrep's general-purpose pack; its noisier audit packs are left for teams to opt into.
const DEFAULT_SEMGREP_RULES = ["p/default"]

export const walkdiffConfigSchema = z.object({
  /** Areas the team considers sensitive beyond the built-in ones. */
  riskPaths: z
    .array(z.object({ pattern: z.string().min(1), severity: z.enum(RiskSeverity), reason: z.string().min(1) }))
    .default([]),
  /** Globs excluded from risk scanning, such as test fixtures full of fake secrets. */
  ignore: z.array(z.string().min(1)).default([]),
  /**
   * `allowed: false` keeps this repository's code from ever being sent to a model. `providers`
   * limits where it can go: "anthropic", "local" for a model on the reviewer's machine, or a
   * host such as "api.openai.com". Null means any.
   */
  ai: z.object({ allowed: z.boolean().default(true), providers: z.array(z.string().min(1)).nullable().default(null) }).default({ allowed: true, providers: null }),
  /** Semgrep rule packs from its registry; an empty list turns Semgrep off. */
  scanners: z
    .object({ semgrep: z.object({ rules: z.array(z.string().regex(/^[pr]\/[\w./-]+$/)).default(DEFAULT_SEMGREP_RULES) }).default({ rules: DEFAULT_SEMGREP_RULES }) })
    .default({ semgrep: { rules: DEFAULT_SEMGREP_RULES } }),
  /** `enabled: false` turns off function metrics, linters and duplicate detection. */
  quality: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /** Globs for coverage reports with names Walkdiff doesn't recognize, in CI artifacts or the PR. */
  coverage: z.object({ paths: z.array(z.string().min(1)).default([]) }).default({ paths: [] }),
  /** Your own packages, as names or globs such as "@acme/*", never looked up on public services. */
  dependencies: z.object({ private: z.array(z.string().min(1)).default([]) }).default({ private: [] }),
  /** Where pilot users send feedback; shown in the report and the PR comment. */
  feedback: z.object({ url: z.url({ protocol: /^https?$/ }).nullable().default(null) }).default({ url: null }),
})
export type WalkdiffConfig = z.infer<typeof walkdiffConfigSchema>

export const DEFAULT_WALKDIFF_CONFIG: WalkdiffConfig = { riskPaths: [], ignore: [], ai: { allowed: true, providers: null }, scanners: { semgrep: { rules: DEFAULT_SEMGREP_RULES } }, quality: { enabled: true }, coverage: { paths: [] }, dependencies: { private: [] }, feedback: { url: null } }

export class WalkdiffConfigError extends Error {
  override readonly name = "WalkdiffConfigError"
}

export async function readWalkdiffConfig(repoDir: string, head: CommitSha): Promise<WalkdiffConfig> {
  const [current, legacy] = await readBlobs(repoDir, [
    { commit: head, path: WALKDIFF_CONFIG_PATH },
    { commit: head, path: LEGACY_CONFIG_PATH },
  ])
  const blob = current ?? legacy
  if (blob === undefined) {
    return DEFAULT_WALKDIFF_CONFIG
  }
  const path = current === undefined ? LEGACY_CONFIG_PATH : WALKDIFF_CONFIG_PATH
  let json: unknown
  try {
    json = JSON.parse(blob.toString("utf8"))
  } catch (error: unknown) {
    throw new WalkdiffConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = walkdiffConfigSchema.safeParse(json)
  if (!result.success) {
    throw new WalkdiffConfigError(`${path} is invalid: ${result.error.message}`)
  }
  return result.data
}

export function isIgnored(config: WalkdiffConfig, path: string): boolean {
  // Changes to the config itself are always reported, whatever it says.
  return path !== WALKDIFF_CONFIG_PATH && path !== LEGACY_CONFIG_PATH && config.ignore.some((pattern) => matchesGlob(path, pattern))
}
