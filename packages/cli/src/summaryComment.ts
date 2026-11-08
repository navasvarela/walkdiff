import { createHash } from "node:crypto"
import { AiReviewStatus, changedUnitsOf, GitHostKind, IntentVerdict, isBehaviourChange, RiskSeverity, SECURITY_SCAN_LIMITS, securityFindings, securitySummary, summarizeChecks, totalsOf, untouchedReferences } from "@walkdiff/review-model"
import type { AiReview, PullRequest, Risk, RiskAssessment, ReviewModel } from "@walkdiff/review-model"

/** Finds this tool's earlier comment so later runs replace it instead of adding another. */
export const SUMMARY_COMMENT_MARKER = "<!-- walkdiff-report -->"

// Served from the default branch, as a comment can't carry its own image. Hosts proxy or fetch it
// without learning anything about the PR. If it's unreachable, the heading still reads fine.
const LOGO_URL = "https://raw.githubusercontent.com/navasvarela/walkdiff/main/docs/assets/walkdiff-logo.svg"
const LOGO_SIZE = 20

// Comments can't set colours: hosts strip styling from them, so these markers carry the severity.
const SEVERITY_LABELS: Readonly<Record<RiskSeverity, string>> = {
  [RiskSeverity.High]: "🔴 High",
  [RiskSeverity.Medium]: "🟠 Medium",
  [RiskSeverity.Low]: "🟡 Low",
}
const SEVERITY_ORDER: readonly RiskSeverity[] = [RiskSeverity.High, RiskSeverity.Medium, RiskSeverity.Low]
const MAX_FINDINGS_SHOWN = 5
// The checks that look for security problems, as opposed to code quality or breaking changes.
const SECURITY_CHECKS: ReadonlySet<string> = new Set(["Built-in rules", "Semgrep", "gitleaks", "OSV database", "osv-scanner", "Dependency trust", "zizmor", "poutine", "Ruff security rules"])

const AlertKind = { Note: "NOTE", Warning: "WARNING", Caution: "CAUTION" } as const
type AlertKind = (typeof AlertKind)[keyof typeof AlertKind]

/** The PR comment: what a reviewer should know before deciding whether to open the report. */
export function renderSummaryComment(model: ReviewModel, reportUrl: string): string {
  const lines = [
    SUMMARY_COMMENT_MARKER,
    `### <img src="${LOGO_URL}" alt="" width="${LOGO_SIZE}" height="${LOGO_SIZE}" align="top"> Walkdiff`,
    "",
    ...securityCallout(model.risk, model.pullRequest),
    "",
    ...glanceTable(model),
    "",
    ...findingsTable(model.risk.findings, model.pullRequest),
    `**[Open the full report](${reportUrl})**. It's a single HTML file; if it downloads, open it in a browser.`,
    "",
    feedbackLine(model.feedbackUrl),
  ]
  return lines.join("\n")
}

function securityCallout(risk: RiskAssessment, pullRequest: PullRequest): string[] {
  const scanners = risk.checksRun.map((check) => check.name).filter((name) => SECURITY_CHECKS.has(name))
  const sentence = `**${securitySummary(risk.findings)}** from ${joinNames(scanners.map(inlineCode))}. ${SECURITY_SCAN_LIMITS}`
  // GitLab only draws these from 17.10, and shows the marker as text before that. GitHub always does.
  if (pullRequest.host !== GitHostKind.GitHub) return [`> ${sentence}`]
  return [`> [!${alertKind(risk)}]`, `> ${sentence}`]
}

function alertKind(risk: RiskAssessment): AlertKind {
  const found = securityFindings(risk.findings)
  if (found.some((finding) => finding.severity === RiskSeverity.High)) return AlertKind.Caution
  // Deliberately not GitHub's green tip: nothing found isn't the same as safe.
  return found.length > 0 ? AlertKind.Warning : AlertKind.Note
}

function glanceTable(model: ReviewModel): string[] {
  const rows = [changesRow(model), ...referencesRow(model), checksRow(model.risk), ...aiRow(model.ai)]
  return ["| At a glance | |", "| --- | --- |", ...rows.map(([label, value]) => `| ${label} | ${value} |`)]
}

type Row = readonly [string, string]

function changesRow(model: ReviewModel): Row {
  const units = model.files.flatMap(changedUnitsOf)
  const toReview = units.filter((unit) => isBehaviourChange(unit.change)).length
  const collapsed = units.length - toReview
  const skippable = model.files.filter((file) => file.noise !== null).length
  const counts = [`**${toReview}** code ${plural(toReview, "unit")} to review`]
  if (collapsed > 0) counts.push(`${collapsed} collapsed as formatting, comments, renames or moves`)
  if (skippable > 0) counts.push(`${skippable} skippable ${plural(skippable, "file")}`)
  return ["**Changes**", counts.join(", ")]
}

function referencesRow(model: ReviewModel): Row[] {
  const untouched = model.files.flatMap(changedUnitsOf).reduce((sum, unit) => sum + untouchedReferences(unit).length, 0)
  return untouched === 0 ? [] : [["**Used elsewhere**", `**${untouched}** ${plural(untouched, "place")} this PR did not touch ${plural(untouched, "uses", "use")} code it changed`]]
}

function checksRow(risk: RiskAssessment): Row {
  const totals = totalsOf(summarizeChecks(risk))
  const ran = totals.clean + totals.withIssues
  const notRun = totals.notRun === 0 ? "" : `, ⚠️ **${totals.notRun} did not run**`
  return ["**Checks**", `**${ran}** ran: ${totals.withIssues} with issues, ${totals.clean} clean${notRun}`]
}

function aiRow(ai: AiReview): Row[] {
  switch (ai.status) {
    case AiReviewStatus.Disabled:
      return []
    case AiReviewStatus.Unavailable:
      return [["**AI review**", "Requested but not produced; the report says why"]]
    case AiReviewStatus.Completed: {
      const differences = ai.intent.filter((finding) => finding.verdict !== IntentVerdict.Matches).length
      return [["**AI review**", `${differences} ${plural(differences, "difference")} from the description, ${ai.questions.length} ${plural(ai.questions.length, "question")} to answer`]]
    }
  }
}

function findingsTable(findings: readonly Risk[], pullRequest: PullRequest): string[] {
  if (findings.length === 0) return []
  const groups = new Map<string, Risk[]>()
  for (const finding of findings) groups.set(finding.title, [...(groups.get(finding.title) ?? []), finding])
  const ordered = [...groups.values()].sort((a, b) => severityRank(a) - severityRank(b))
  const rows = ordered.slice(0, MAX_FINDINGS_SHOWN).flatMap((group) => {
    const first = group.at(0)
    return first === undefined ? [] : [`| ${SEVERITY_LABELS[first.severity]} | ${formatTitle(first.title)} | ${whereCell(group, pullRequest)} |`]
  })
  const hidden = ordered.length - rows.length
  return ["| Severity | Finding | Where |", "| --- | --- | --- |", ...rows, ...(hidden > 0 ? ["", `And ${hidden} more in the report.`] : []), ""]
}

function severityRank(group: readonly Risk[]): number {
  const severity = group.at(0)?.severity
  return severity === undefined ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(severity)
}

function whereCell(group: readonly Risk[], pullRequest: PullRequest): string {
  const first = group.at(0)
  if (first?.location == null) return "This PR"
  const { path, line } = first.location
  const label = inlineCode(line === null ? path : `${path}:${line}`)
  const link = `[${label}](${diffLink(pullRequest, path, line)})`
  return group.length > 1 ? `${link} and ${group.length - 1} more` : link
}

/**
 * Links into the PR's own diff, where the reviewer can comment. These anchors are how each host
 * addresses a file: GitHub's is the path's SHA-256, GitLab's its SHA-1. They aren't documented, but
 * a wrong one only opens the diff at the top. GitLab needs both old and new line numbers to reach
 * a line, and a finding only has the new one, so its links stop at the file.
 */
export function diffLink(pullRequest: PullRequest, path: string, line: number | null): string {
  if (pullRequest.host === GitHostKind.GitLab) {
    return `${pullRequest.url}/diffs#${createHash("sha1").update(path).digest("hex")}`
  }
  const lineAnchor = line === null ? "" : `R${line}`
  return `${pullRequest.url}/files#diff-${createHash("sha256").update(path).digest("hex")}${lineAnchor}`
}

/** Text outside `code` marks is escaped, and text inside is inert, so neither can act on the page. */
function formatTitle(title: string): string {
  return title
    .split("`")
    .map((part, index) => (index % 2 === 1 ? inlineCode(part) : escapeMarkdown(part)))
    .join("")
}

function joinNames(names: readonly string[]): string {
  const last = names.at(-1) ?? ""
  return names.length < 2 ? last : `${names.slice(0, -1).join(", ")} and ${last}`
}

function feedbackLine(feedbackUrl: string | null): string {
  const form = feedbackUrl === null ? "" : `, or [leave feedback](${feedbackUrl})`
  return `Was this useful? React with 👍 or 👎${form}.`
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

/**
 * Titles carry names from the PR, such as functions and packages. Anyone can open a PR, so
 * a crafted name must not ping people, add links or images, or close the table.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>|~!]/g, "\\$&")
    .replace(/([@#])/g, "$1​")
}

// A pipe ends a table cell even inside code, unless it's escaped.
function inlineCode(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, "").replaceAll("|", "\\|")}\``
}
