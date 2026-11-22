import { ReviewStatus, RiskSeverity, stepPosition } from "@walkdiff/review-model"
import type { ReviewModel, ReviewSummary, Risk } from "@walkdiff/review-model"

/** What the reviews view shows for one review, apart from how VS Code draws it. */
export interface ReviewRow {
  readonly label: string
  readonly description: string
  readonly tooltip: string
  /** Matched by the menus in package.json, as `review.<status>`. */
  readonly contextValue: string
}

/** One changed file of a review, with the findings that point into it. */
export interface ChangedFileRow {
  readonly path: string
  /** Where the file was before a rename or copy; the same as `path` otherwise. */
  readonly basePath: string
  readonly description: string
  readonly findings: readonly Risk[]
  /** A lockfile, generated or vendored file, which a reviewer can usually skip. */
  readonly isNoise: boolean
}

const SEVERITY_ORDER: readonly RiskSeverity[] = [RiskSeverity.High, RiskSeverity.Medium, RiskSeverity.Low]

export function reviewRow(review: ReviewSummary): ReviewRow {
  const label = review.title === null ? review.displayName : `${review.displayName} ${review.title}`
  const description = statusText(review)
  return { label, description, tooltip: `${review.url}\n${description}`, contextValue: `review.${review.status}` }
}

function statusText(review: ReviewSummary): string {
  switch (review.status) {
    case ReviewStatus.Queued:
      return "Waiting to start"
    case ReviewStatus.Analyzing: {
      if (review.step === null) return "Analyzing"
      const { number, total, label } = stepPosition(review.step, review.ai)
      return `${label} (${number} of ${total})`
    }
    case ReviewStatus.Failed:
      return review.error ?? "Failed"
    case ReviewStatus.Ready:
      return readyText(review)
  }
}

function readyText(review: ReviewSummary): string {
  const parts = [
    review.unitsToReview === null ? undefined : `${review.unitsToReview} to review`,
    review.findings === null ? undefined : count(review.findings, "finding"),
    review.securityLevel === null || review.securityLevel === RiskSeverity.Low ? undefined : `${review.securityLevel} security`,
  ]
  return parts.filter((part) => part !== undefined).join(" · ")
}

/** Whether any review is still being analyzed, so the list is worth checking again soon. */
export function isAnalyzing(reviews: readonly ReviewSummary[]): boolean {
  return reviews.some((review) => review.status === ReviewStatus.Queued || review.status === ReviewStatus.Analyzing)
}

/** The report's changed files in its own order, as git lists them, with the files a reviewer can usually skip after the rest. */
export function changedFileRows(report: ReviewModel): ChangedFileRow[] {
  const rows = report.files.map(({ diff, noise }): ChangedFileRow => {
    const findings = bySeverity(report.risk.findings.filter((finding) => finding.location?.path === diff.path))
    const basePath = "previousPath" in diff ? diff.previousPath : diff.path
    const parts = [`+${diff.additions} −${diff.deletions}`, basePath === diff.path ? undefined : `from ${basePath}`, noise?.kind, findings.length === 0 ? undefined : count(findings.length, "finding")]
    return { path: diff.path, basePath, description: parts.filter((part) => part !== undefined).join(" · "), findings, isNoise: noise !== null }
  })
  return [...rows.filter((row) => !row.isNoise), ...rows.filter((row) => row.isNoise)]
}

/** Findings about the PR as a whole, or about files it doesn't change, which no file row shows. */
export function pullRequestFindings(report: ReviewModel): Risk[] {
  const changed = new Set(report.files.map(({ diff }) => diff.path))
  return bySeverity(report.risk.findings.filter((finding) => finding.location === null || !changed.has(finding.location.path)))
}

export function findingLabel(finding: Risk): string {
  return `${finding.severity}: ${finding.title}`
}

function bySeverity(findings: readonly Risk[]): Risk[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}
