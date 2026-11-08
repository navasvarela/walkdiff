import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import { z } from "zod"
import type { ScannerFinding } from "./scannerFinding.ts"
import { pathInScanRoot } from "./scanWorkspace.ts"

export const POUTINE_BINARY = "poutine"
export const POUTINE_CONFIG_FILE = "poutine-config.yml"
export const POUTINE_RULE_PREFIX = "poutine."

const SEVERITIES: Readonly<Record<string, RiskSeverity>> = { error: RiskSeverity.High, warning: RiskSeverity.Medium, note: RiskSeverity.Low }

// poutine calls these notes. Piping a download into a shell runs whatever that server returns with
// the job's secrets, and debug tracing prints every variable, masked ones included, into the job
// log. Both deserve the same attention as its warnings.
const SEVERITY_OVERRIDES: Readonly<Record<string, RiskSeverity>> = { unverified_script_exec: RiskSeverity.Medium, debug_enabled: RiskSeverity.Medium }

const poutineOutputSchema = z.object({
  findings: z.array(
    z.object({
      rule_id: z.string(),
      meta: z.object({ path: z.string().optional(), line: z.number().int().optional(), details: z.string().optional() }).loose(),
    }).loose(),
  ).nullable(),
  rules: z.record(z.string(), z.object({ title: z.string(), description: z.string(), level: z.string() }).loose()),
}).loose()

/**
 * Our own `--config` means a `.poutine.yml` in the change can't skip rules, and the version check
 * is the only network call poutine makes on a local folder.
 */
export function poutineArgs(configPath: string): string[] {
  return ["analyze_local", ".", "--format", "json", "--quiet", "--disable-version-check", "--config", configPath]
}

/** `texts` holds each scanned file by path, to place findings poutine reports without a line. */
export function parsePoutineOutput(stdout: string, root: string, texts: ReadonlyMap<string, string>): ScannerFinding[] {
  const output = poutineOutputSchema.parse(JSON.parse(stdout))
  return (output.findings ?? []).flatMap((finding) => {
    if (finding.meta.path === undefined) return []
    const path = pathInScanRoot(root, finding.meta.path)
    const line = finding.meta.line ?? lineMentioning(texts.get(path), finding.meta.details)
    if (line === undefined) return []
    const rule = output.rules[finding.rule_id]
    const description = rule?.description.replaceAll("\n", " ").trim()
    return [{
      ruleId: `${POUTINE_RULE_PREFIX}${finding.rule_id}`,
      category: RiskCategory.CodeScan,
      severity: SEVERITY_OVERRIDES[finding.rule_id] ?? SEVERITIES[rule?.level ?? ""] ?? RiskSeverity.Medium,
      title: rule?.title ?? finding.rule_id.replaceAll("_", " "),
      detail: [finding.meta.details === undefined ? undefined : `${finding.meta.details}.`, description, "Reported by poutine."].filter((part) => part !== undefined).join(" "),
      path,
      line,
      endLine: line,
      showLine: true,
    }]
  })
}

// Some findings, such as debug tracing, name what they found but not where. The first line that
// names it is where a reviewer would look.
function lineMentioning(text: string | undefined, details: string | undefined): number | undefined {
  if (text === undefined || details === undefined) return undefined
  const names = details.split(/\s+/).filter((name) => name !== "")
  const index = text.split("\n").findIndex((line) => names.some((name) => line.includes(name)))
  return index === -1 ? undefined : index + 1
}
