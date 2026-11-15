import { DiffLineKind, FileContentKind, NoiseKind } from "@walkdiff/review-model"
import type { FileDiff, FileNoise, Risk, RiskCategory, RiskSeverity } from "@walkdiff/review-model"

/** What risk scanners see of a changed file. */
export interface ScannedFile {
  readonly diff: FileDiff
  readonly noise: FileNoise | null
  /** Head version, when it is text the engine read. */
  readonly after: string | undefined
}

export interface AddedLine {
  readonly line: number
  readonly content: string
}

export function addedLines(diff: FileDiff): AddedLine[] {
  if (diff.content.kind === FileContentKind.Binary) {
    return []
  }
  return diff.content.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => (line.kind === DiffLineKind.Added ? [{ line: line.newLine, content: line.content }] : [])),
  )
}

export function removedLines(diff: FileDiff): AddedLine[] {
  if (diff.content.kind === FileContentKind.Binary) {
    return []
  }
  return diff.content.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => (line.kind === DiffLineKind.Removed ? [{ line: line.oldLine, content: line.content }] : [])),
  )
}

/** Lockfiles and vendored code are third-party content; scanning them only produces noise. */
export function isThirdParty(file: ScannedFile): boolean {
  return file.noise?.kind === NoiseKind.Lockfile || file.noise?.kind === NoiseKind.Vendored
}

/** The fields every rule shares, from which each finding is made. */
export interface RuleDescription {
  readonly id: string
  readonly category: RiskCategory
  readonly severity: RiskSeverity
  readonly title: string
  readonly detail: string
}

const MAX_EVIDENCE_CHARS = 200

export function findingAt(rule: RuleDescription, path: string, line: number | null, evidence: string | null): Risk {
  return {
    ruleId: rule.id,
    category: rule.category,
    severity: rule.severity,
    title: rule.title,
    detail: rule.detail,
    location: { path, line },
    evidence: evidence === null ? null : evidence.trim().slice(0, MAX_EVIDENCE_CHARS),
  }
}

/** A finding about the PR as a whole, such as its size, with no single place to point at. */
export function pullRequestFinding(rule: RuleDescription): Risk {
  return { ruleId: rule.id, category: rule.category, severity: rule.severity, title: rule.title, detail: rule.detail, location: null, evidence: null }
}
