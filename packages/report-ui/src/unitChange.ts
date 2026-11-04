import { changedUnitsOf, isBehaviourChange, ModificationWeight, UnitChangeKind, UnitKind, untouchedReferences } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, UnitChange, UnitFacts } from "@walkdiff/review-model"

export const Tone = { Added: "added", Removed: "removed", Modified: "modified", Quiet: "quiet" } as const
export type Tone = (typeof Tone)[keyof typeof Tone]

export interface ChangeLabel {
  readonly text: string
  readonly tone: Tone
}

export function changeLabel(change: UnitChange): ChangeLabel {
  switch (change.kind) {
    case UnitChangeKind.Added:
      return { text: "Added", tone: Tone.Added }
    case UnitChangeKind.Removed:
      return { text: "Removed", tone: Tone.Removed }
    case UnitChangeKind.Modified:
      return modificationLabel(change.weight)
    case UnitChangeKind.Renamed:
      return { text: `Renamed from ${change.previousName}`, tone: Tone.Quiet }
    case UnitChangeKind.MovedIn:
      return change.edited ? { text: `Moved from ${change.from.path} and edited`, tone: Tone.Modified } : { text: `Moved from ${change.from.path}`, tone: Tone.Quiet }
    case UnitChangeKind.MovedOut:
      return { text: `Moved to ${change.to.path}`, tone: Tone.Quiet }
  }
}

function modificationLabel(weight: ModificationWeight): ChangeLabel {
  switch (weight) {
    case ModificationWeight.Semantic:
      return { text: "Modified", tone: Tone.Modified }
    case ModificationWeight.CommentsOnly:
      return { text: "Comments only", tone: Tone.Quiet }
    case ModificationWeight.FormattingOnly:
      return { text: "Formatting only", tone: Tone.Quiet }
  }
}

/** Changes that leave behaviour as it was: shown collapsed so attention goes elsewhere. */
export function isQuiet(unit: ChangedUnit): boolean {
  return !isBehaviourChange(unit.change)
}

export interface FileSummary {
  readonly needsAttention: number
  readonly quiet: number
  /** References to this file's changed units from code the PR did not touch. */
  readonly untouchedReferences: number
}

export function summarizeFile(file: ChangedFile): FileSummary {
  const units = changedUnitsOf(file)
  const quiet = units.filter(isQuiet).length
  const untouched = units.reduce((sum, unit) => sum + untouchedReferences(unit).length, 0)
  return { needsAttention: units.length - quiet, quiet, untouchedReferences: untouched }
}

export const UNIT_KIND_LABELS: Readonly<Record<UnitKind, string>> = {
  [UnitKind.Function]: "fn",
  [UnitKind.Method]: "method",
  [UnitKind.Class]: "class",
  [UnitKind.Struct]: "struct",
  [UnitKind.Enum]: "enum",
  [UnitKind.Trait]: "trait",
  [UnitKind.Impl]: "impl",
  [UnitKind.Interface]: "interface",
  [UnitKind.TypeAlias]: "type",
  [UnitKind.Constant]: "const",
  [UnitKind.Macro]: "macro",
  [UnitKind.Module]: "module",
  [UnitKind.ModuleScope]: "imports & top level",
}

export function unitAnchorId(index: number): string {
  return `unit-${index}`
}

const MAX_CALLS_NAMED = 5

/** The facts as short phrases, most consequential first. */
export function factPhrases(facts: UnitFacts): string[] {
  const phrases: string[] = []
  const list = (names: readonly string[]): string => {
    const shown = names.slice(0, MAX_CALLS_NAMED).join(", ")
    return names.length > MAX_CALLS_NAMED ? `${shown} and ${names.length - MAX_CALLS_NAMED} more` : shown
  }
  if (facts.parametersAdded.length > 0) phrases.push(`New ${count(facts.parametersAdded.length, "parameter")}: ${list(facts.parametersAdded)}`)
  if (facts.parametersRemoved.length > 0) phrases.push(`Removed ${count(facts.parametersRemoved.length, "parameter")}: ${list(facts.parametersRemoved)}`)
  if (facts.parametersChanged.length > 0) phrases.push(`Changed ${count(facts.parametersChanged.length, "parameter")}: ${list(facts.parametersChanged)}`)
  if (facts.returnType !== null) phrases.push(`Return type: ${facts.returnType.before ?? "none"} → ${facts.returnType.after ?? "none"}`)
  if (facts.errorPathsDelta !== 0) phrases.push(delta(facts.errorPathsDelta, "error path"))
  if (facts.branchesDelta !== 0) phrases.push(delta(facts.branchesDelta, "branch", "branches"))
  if (facts.complexity !== null) phrases.push(`Complexity ${facts.complexity.before} → ${facts.complexity.after}`)
  if (facts.callsAdded.length > 0) phrases.push(`Now calls ${list(facts.callsAdded)}`)
  if (facts.callsRemoved.length > 0) phrases.push(`No longer calls ${list(facts.callsRemoved)}`)
  return phrases
}

function count(amount: number, singular: string, plural = `${singular}s`): string {
  return amount === 1 ? singular : plural
}

function delta(amount: number, singular: string, plural = `${singular}s`): string {
  const size = Math.abs(amount)
  return amount > 0 ? `${size} more ${count(size, singular, plural)}` : `${size} fewer ${count(size, singular, plural)}`
}
