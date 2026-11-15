import { DimensionKind, RiskCategory } from "./schema.ts"
import type { Dimension } from "./schema.ts"

function dimension(id: RiskCategory, label: string, kind: DimensionKind, advice: string): Dimension {
  return { id, label, kind, advice }
}

/**
 * The dimensions Walkdiff's own checks use, in the order a reviewer should look at them. Reports
 * from before dimensions were part of the report have none listed, and read them from here.
 *
 * Breaking changes aren't security: they can take down a deployment but expose nothing to an
 * attacker, and security wording raised by a renamed column would teach people to discount it.
 */
export const BUILT_IN_DIMENSIONS: readonly Dimension[] = [
  dimension(RiskCategory.Secret, "Possible secret", DimensionKind.Security, "If it's real, revoke it."),
  dimension(RiskCategory.AttackSurface, "Attack surface", DimensionKind.Security, "Check who can reach it and what it trusts."),
  dimension(RiskCategory.DangerousApi, "Risky API", DimensionKind.Security, "Check that users can't control the input."),
  dimension(RiskCategory.SupplyChain, "Supply chain", DimensionKind.Security, "Check where the package comes from before installing it."),
  dimension(RiskCategory.Dependency, "Dependency", DimensionKind.Security, "Check that you trust it."),
  dimension(RiskCategory.Vulnerability, "Known vulnerability", DimensionKind.Security, "Upgrade before merging if you can."),
  dimension(RiskCategory.Infrastructure, "Infrastructure", DimensionKind.Security, "Check it's intended for this environment."),
  dimension(RiskCategory.SensitivePath, "Sensitive area", DimensionKind.Security, "Check this is intended."),
  dimension(RiskCategory.CodeScan, "Code scan", DimensionKind.Security, "Check whether it applies here."),
  dimension(RiskCategory.BreakingChange, "Breaking change", DimensionKind.Review, "This may break callers or a deployment, so check who depends on it."),
  dimension(RiskCategory.BrokenReference, "Broken reference", DimensionKind.Review, "Check that nothing still depends on it."),
  dimension(RiskCategory.License, "Licence", DimensionKind.Review, "Check it's acceptable before merging."),
  dimension(RiskCategory.Tests, "Tests", DimensionKind.Review, "Ask whether this needs tests."),
  dimension(RiskCategory.CodeQuality, "Code quality", DimensionKind.Context, ""),
  dimension(RiskCategory.Size, "Size", DimensionKind.Context, ""),
]

const BUILT_IN_BY_ID: ReadonlyMap<string, Dimension> = new Map(BUILT_IN_DIMENSIONS.map((entry) => [entry.id, entry]))

/**
 * The description of a finding's category: the report's own first, then the built-in one. A
 * category neither knows, which a newer engine could write, still gets a label and a review step.
 */
export function dimensionOf(id: string, dimensions: readonly Dimension[] | undefined): Dimension {
  return dimensions?.find((entry) => entry.id === id) ?? BUILT_IN_BY_ID.get(id) ?? { id, label: id, kind: DimensionKind.Review, advice: "Check whether it applies here." }
}
