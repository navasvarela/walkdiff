import type { Risk } from "@walkdiff/review-model"

/** The check the built-in rule sets, review signals and new-dependency notes are reported under. */
export const BUILT_IN_RULES_NAME = "Built-in rules"

/** Names the check that raised each finding, as its run is named, so the report counts it there. */
export function creditedTo(checkName: string, findings: readonly Risk[]): Risk[] {
  return findings.map((finding) => ({ ...finding, check: checkName }))
}
