import { changedUnitsOf, CitationSide as Side, DiffLineKind, FileContentKind, isBehaviourChange, UnitChangeKind, UnitImpactStatus, untouchedReferences } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, CitationSide, FileDiff, PullRequest, RiskAssessment, UnitChange, UnitRef, UnitSnapshot } from "@walkdiff/review-model"

import { isSecretFile, redactSecretsInText } from "../risk/secrets.ts"

export interface ReviewContext {
  readonly pullRequest: PullRequest
  readonly files: readonly ChangedFile[]
  readonly risk: RiskAssessment
}

/** A line range shown to the model, which citations must fall inside. */
export interface ShownRange {
  readonly path: string
  readonly side: CitationSide
  readonly startLine: number
  readonly endLine: number
}

export interface PromptPlan {
  readonly text: string
  /** Unit ids used in the prompt (`U1`, `U2`, …), so chapters can name units unambiguously. */
  readonly unitsById: ReadonlyMap<string, UnitRef>
  readonly shownRanges: readonly ShownRange[]
  /** Units listed by name only because the input budget ran out. */
  readonly summarizedOnly: number
}

// A rough, conservative conversion for code (real tokenizers give 3.5–4.5 characters per
// token). Only used to stay under the budget, never for billing.
const CHARS_PER_TOKEN = 3.5
// Room for the system prompt and the PR description framing.
const FIXED_OVERHEAD_TOKENS = 2000

/**
 * Renders the change for the model. Units that change behaviour come first, most-used
 * first, each with its full before and after text and line numbers. Once the budget is
 * spent, the remaining units are listed by name only, and the plan says how many.
 */
export function buildPrompt(context: ReviewContext, maxInputTokens: number): PromptPlan {
  let remaining = Math.max(0, (maxInputTokens - FIXED_OVERHEAD_TOKENS) * CHARS_PER_TOKEN)
  const fits = (section: string): boolean => {
    if (section.length > remaining) return false
    remaining -= section.length
    return true
  }

  const unitsById = new Map<string, UnitRef>()
  const shownRanges: ShownRange[] = []
  const unitSections: string[] = []
  let summarizedOnly = 0

  orderedUnits(context.files).forEach(({ path, unit }, index) => {
    const id = `U${index + 1}`
    unitsById.set(id, { path, qualifiedName: unit.qualifiedName })
    const full = renderUnit(id, path, unit)
    if (fits(full.text)) {
      unitSections.push(full.text)
      shownRanges.push(...full.ranges)
    } else {
      summarizedOnly++
      unitSections.push(unitHeader(id, path, unit, true))
    }
  })

  const otherSections = context.files
    .filter((file) => file.noise === null && changedUnitsOf(file).length === 0)
    .map((file) => {
      if (isSecretFile(file.diff.path)) {
        return `<file path="${attribute(file.diff.path)}" status="${file.diff.status}" omitted="may hold credentials"/>`
      }
      const rendered = renderHunks(file.diff)
      if (fits(rendered.text)) {
        shownRanges.push(...rendered.ranges)
        return rendered.text
      }
      return `<file path="${attribute(file.diff.path)}" status="${file.diff.status}" omitted="input budget reached"/>`
    })

  const text = [
    renderPullRequest(context.pullRequest),
    section("changed_units", unitSections),
    section("other_changed_files", otherSections),
    section(
      "skippable_files",
      context.files.filter((file) => file.noise !== null).map((file) => `${file.diff.path} (${file.noise?.kind ?? ""})`),
    ),
    section(
      "risk_findings",
      context.risk.findings.map((finding) => {
        const where = finding.location === null ? "whole PR" : `${finding.location.path}${finding.location.line === null ? "" : `:${finding.location.line}`}`
        return `[${finding.severity}] ${finding.title} (${where})`
      }),
    ),
  ].join("\n\n")
  // Redacted last, so nothing added above can bypass it, and the cache key never holds a secret.
  return { text: redactSecretsInText(text), unitsById, shownRanges, summarizedOnly }
}

interface LocatedUnit {
  readonly path: string
  readonly unit: ChangedUnit
}

function orderedUnits(files: readonly ChangedFile[]): LocatedUnit[] {
  const located = files.flatMap((file) => changedUnitsOf(file).map((unit) => ({ path: file.diff.path, unit })))
  return located.sort((a, b) => priority(b.unit) - priority(a.unit))
}

// Behaviour changes first, then by how much untouched code depends on the unit.
function priority(unit: ChangedUnit): number {
  const behaviour = isBehaviourChange(unit.change) ? 1_000_000 : 0
  return behaviour + untouchedReferences(unit).length
}

interface Rendered {
  readonly text: string
  readonly ranges: ShownRange[]
}

function renderUnit(id: string, path: string, unit: ChangedUnit): Rendered {
  const parts: string[] = [unitHeader(id, path, unit, false)]
  const ranges: ShownRange[] = []
  const show = (label: string, side: CitationSide, snapshot: UnitSnapshot): void => {
    parts.push(`--- ${label} (${side}, lines ${snapshot.startLine}-${snapshot.endLine})`)
    parts.push(numbered(snapshot))
    ranges.push({ path, side, startLine: snapshot.startLine, endLine: snapshot.endLine })
  }
  const { change } = unit
  // An unedited move's before is its after, so showing both would only spend the budget.
  const beforeAddsNothing = change.kind === UnitChangeKind.MovedIn && !change.edited
  if ("before" in change && !beforeAddsNothing) show("before", Side.Before, change.before)
  if ("after" in change) show("after", Side.After, change.after)
  parts.push("</unit>")
  return { text: parts.join("\n"), ranges }
}

function changeAttribute(change: UnitChange): string {
  if (change.kind === UnitChangeKind.Modified) return `modified (${change.weight})`
  if (change.kind === UnitChangeKind.MovedIn && change.edited) return `${change.kind} (edited)`
  return change.kind
}

function unitHeader(id: string, path: string, unit: ChangedUnit, summarized: boolean): string {
  const change = changeAttribute(unit.change)
  const impact = unit.impact?.status === UnitImpactStatus.Traced ? ` callers="${unit.impact.totalReferences}"` : ""
  const close = summarized ? ` summarized="input budget reached"/>` : ">"
  return `<unit id="${id}" path="${attribute(path)}" name="${attribute(unit.qualifiedName)}" kind="${unit.kind}" change="${change}"${impact}${close}`
}

// Container snapshots collapse nested units, so their rows no longer map to file lines.
function numbered(snapshot: UnitSnapshot): string {
  const lines = snapshot.text.split("\n")
  if (snapshot.elidesNestedUnits) return lines.join("\n")
  return lines.map((line, index) => `${snapshot.startLine + index}| ${line}`).join("\n")
}

/** Hunks with each line's number on its own side: `+`/` ` lines use head numbers, `-` lines base numbers. */
function renderHunks(diff: FileDiff): Rendered {
  const head = `<file path="${attribute(diff.path)}" status="${diff.status}">`
  if (diff.content.kind === FileContentKind.Binary) {
    return { text: `${head}\n(binary)\n</file>`, ranges: [] }
  }
  const ranges: ShownRange[] = []
  const body = diff.content.hunks.flatMap((hunk) => {
    if (hunk.newLines > 0) ranges.push({ path: diff.path, side: Side.After, startLine: hunk.newStart, endLine: hunk.newStart + hunk.newLines - 1 })
    if (hunk.oldLines > 0) ranges.push({ path: diff.path, side: Side.Before, startLine: hunk.oldStart, endLine: hunk.oldStart + hunk.oldLines - 1 })
    return [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines.map((line) => {
        switch (line.kind) {
          case DiffLineKind.Added:
            return `+${line.newLine}| ${line.content}`
          case DiffLineKind.Removed:
            return `-${line.oldLine}| ${line.content}`
          case DiffLineKind.Context:
            return ` ${line.newLine}| ${line.content}`
        }
      }),
    ]
  })
  return { text: [head, ...body, "</file>"].join("\n"), ranges }
}

function renderPullRequest(pullRequest: PullRequest): string {
  return [
    "<pull_request>",
    `Title: ${pullRequest.title}`,
    `Author: ${pullRequest.author}`,
    `Merging ${pullRequest.headRef} into ${pullRequest.baseRef}`,
    "Description:",
    pullRequest.description.trim() === "" ? "(empty)" : pullRequest.description,
    "</pull_request>",
  ].join("\n")
}

function section(name: string, lines: readonly string[]): string {
  return lines.length === 0 ? `<${name}>(none)</${name}>` : `<${name}>\n${lines.join("\n")}\n</${name}>`
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}
