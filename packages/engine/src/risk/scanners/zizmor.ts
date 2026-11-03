import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import { z } from "zod"
import type { ScannerFinding } from "./scannerFinding.ts"
import { pathInScanRoot } from "./scanWorkspace.ts"

export const ZIZMOR_BINARY = "zizmor"
export const ZIZMOR_CONFIG_FILE = "zizmor-config.yml"

const SEVERITIES: Readonly<Record<string, RiskSeverity>> = { High: RiskSeverity.High, Medium: RiskSeverity.Medium, Low: RiskSeverity.Low, Informational: RiskSeverity.Low }

// zizmor rates a tag such as @v4 as high, which would give almost any PR adding a workflow the same
// warning as code injection. It's a real supply chain risk, so it stays, one level lower.
const SEVERITY_OVERRIDES: Readonly<Record<string, RiskSeverity>> = { "unpinned-uses": RiskSeverity.Medium }

const zizmorOutputSchema = z.array(
  z.object({
    ident: z.string(),
    desc: z.string(),
    url: z.string().optional(),
    determinations: z.object({ severity: z.string() }).loose(),
    locations: z.array(
      z.object({
        symbolic: z.object({ key: z.object({ Local: z.object({ verbatim_path: z.string() }).loose() }).loose(), kind: z.string().optional() }).loose(),
        concrete: z.object({ location: z.object({ start_point: z.object({ row: z.number().int() }).loose(), end_point: z.object({ row: z.number().int() }).loose() }).loose() }).loose(),
      }),
    ),
  }).loose(),
)

/**
 * `--no-ignores` stops `# zizmor: ignore` comments in a PR hiding its own findings, and our own
 * `--config` means no file in the PR is read as configuration. `--offline` keeps the workflow's
 * contents on this machine, and its audits that would call GitHub aren't run. Exit codes 11 and up
 * only say how severe the findings were, so they're turned off: any other failure still shows.
 */
export function zizmorArgs(configPath: string): string[] {
  return ["--format=json-v1", "--offline", "--no-ignores", "--no-exit-codes", "--min-confidence=medium", "--collect=workflows,actions", "--config", configPath, "."]
}

export function parseZizmorOutput(stdout: string, root: string): ScannerFinding[] {
  return zizmorOutputSchema.parse(JSON.parse(stdout)).flatMap((finding) => {
    const primary = finding.locations.find((location) => location.symbolic.kind === "Primary") ?? finding.locations.at(0)
    if (primary === undefined) return []
    const location = primary.concrete.location
    return [{
      ruleId: `zizmor.${finding.ident}`,
      category: RiskCategory.CodeScan,
      severity: SEVERITY_OVERRIDES[finding.ident] ?? SEVERITIES[finding.determinations.severity] ?? RiskSeverity.Medium,
      title: finding.ident.replaceAll("-", " "),
      detail: `${finding.desc}. Reported by zizmor.${finding.url === undefined ? "" : ` See ${finding.url}.`}`,
      path: pathInScanRoot(root, primary.symbolic.key.Local.verbatim_path),
      // zizmor counts lines from 0 in this format.
      line: location.start_point.row + 1,
      endLine: location.end_point.row + 1,
      showLine: true,
    }]
  })
}
