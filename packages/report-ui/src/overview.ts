import { BUILT_IN_DIMENSIONS, dimensionOf, DimensionKind, RiskSeverity } from "@walkdiff/review-model"
import type { Dimension, Risk, RiskAssessment } from "@walkdiff/review-model"
import { worstSeverity } from "./risks.ts"
import { ReportTab } from "./tabs.ts"

/** One dimension's findings, as a section of the Risks overview. */
export interface DimensionSection {
  readonly dimension: Dimension
  readonly findings: readonly Risk[]
  readonly worst: RiskSeverity
}

const SEVERITY_ORDER: readonly RiskSeverity[] = [RiskSeverity.High, RiskSeverity.Medium, RiskSeverity.Low]

/** The order kinds are shown in: what can be exploited, then what needs a decision, then background. */
const KIND_ORDER: readonly DimensionKind[] = [DimensionKind.Security, DimensionKind.Review, DimensionKind.Context]

export const KIND_LABELS: Readonly<Record<DimensionKind, string>> = {
  [DimensionKind.Security]: "Security",
  [DimensionKind.Review]: "Needs a decision",
  [DimensionKind.Context]: "Background",
}

/**
 * The dimensions with findings, each with its own findings in their incoming order (most severe
 * first). Sections follow the kind order, then their worst finding, then the built-in dimensions'
 * order, so what a reviewer should look at first is at the top. Dimensions a check declared come
 * after the built-in ones of their kind and severity.
 */
export function dimensionSections(risk: RiskAssessment): DimensionSection[] {
  const byCategory = new Map<string, Risk[]>()
  for (const finding of risk.findings) {
    const group = byCategory.get(finding.category)
    if (group === undefined) byCategory.set(finding.category, [finding])
    else group.push(finding)
  }
  const sections = [...byCategory].flatMap(([category, findings]): DimensionSection[] => {
    const worst = worstSeverity(findings)
    return worst === undefined ? [] : [{ dimension: dimensionOf(category, risk.dimensions), findings, worst }]
  })
  return sections.sort(
    (a, b) => KIND_ORDER.indexOf(a.dimension.kind) - KIND_ORDER.indexOf(b.dimension.kind) || SEVERITY_ORDER.indexOf(a.worst) - SEVERITY_ORDER.indexOf(b.worst) || builtInRank(a.dimension) - builtInRank(b.dimension),
  )
}

function builtInRank(dimension: Dimension): number {
  const index = BUILT_IN_DIMENSIONS.findIndex((builtIn) => builtIn.id === dimension.id)
  return index === -1 ? BUILT_IN_DIMENSIONS.length : index
}

/**
 * What else there is, under the security summary, which already counts security findings:
 * "Also 1 needs a decision · 5 for background". Empty when there's nothing else.
 */
export function kindSummary(sections: readonly DimensionSection[]): string {
  const counts = new Map<DimensionKind, number>()
  for (const section of sections) counts.set(section.dimension.kind, (counts.get(section.dimension.kind) ?? 0) + section.findings.length)
  const parts = [...OTHER_KIND_WORDING].flatMap(([kind, wording]) => {
    const count = counts.get(kind) ?? 0
    return count === 0 ? [] : [wording(count)]
  })
  return parts.length === 0 ? "" : `Also ${parts.join(" · ")}`
}

const OTHER_KIND_WORDING: ReadonlyMap<DimensionKind, (count: number) => string> = new Map([
  [DimensionKind.Review, (count: number) => `${count} ${count === 1 ? "needs" : "need"} a decision`],
  [DimensionKind.Context, (count: number) => `${count} for background`],
])

/** The Risks overview's one section that isn't a dimension: what ran, and what didn't. */
export const CHECKS_SECTION = "checks"

const RISKS_PREFIX = `#${ReportTab.Risks}/`

/** A link to one section of the Risks overview, such as `#risks/supplyChain`, which a reviewer can share. */
export function overviewHash(section: string): string {
  return `${RISKS_PREFIX}${encodeURIComponent(section)}`
}

/** The section a link points at; undefined for the overview's top or any other tab. */
export function overviewSectionFromHash(hash: string): string | undefined {
  if (!hash.startsWith(RISKS_PREFIX)) return undefined
  const section = decodeURIComponent(hash.slice(RISKS_PREFIX.length))
  return section === "" ? undefined : section
}

/** The id of a section's element, kept apart from other ids on the page. */
export function sectionElementId(section: string): string {
  return `overview-${section}`
}
