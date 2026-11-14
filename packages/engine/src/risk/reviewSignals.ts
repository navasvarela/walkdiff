import { changedUnitsOf, codeSpan, isBehaviourChange, isTestPath, isTestUnit, ReferenceConfidence, RiskCategory, RiskSeverity, UnitChangeKind, UnitImpactStatus, untouchedReferences } from "@walkdiff/review-model"
import type { ChangedFile, Risk } from "@walkdiff/review-model"
import { findingAt, pullRequestFinding } from "./scannedFile.ts"
import type { RuleDescription } from "./scannedFile.ts"

// Defect detection drops sharply past about 400 lines per review, per the SmartBear/Cisco
// study of 2,500 code reviews. The upper threshold is a judgement call.
const LARGE_CHANGE_LINES = 400
const VERY_LARGE_CHANGE_LINES = 1000

/** Signals about the PR as a whole that tell reviewers where to look harder. */
export function reviewSignals(files: readonly ChangedFile[]): Risk[] {
  return [...sizeSignal(files), ...missingTestsSignal(files), ...brokenReferenceSignals(files)]
}

function sizeSignal(files: readonly ChangedFile[]): Risk[] {
  const changedLines = files
    .filter((file) => file.noise === null)
    .reduce((sum, file) => sum + file.diff.additions + file.diff.deletions, 0)
  if (changedLines <= LARGE_CHANGE_LINES) return []
  const rule: RuleDescription = {
    id: "size.large",
    category: RiskCategory.Size,
    severity: changedLines > VERY_LARGE_CHANGE_LINES ? RiskSeverity.High : RiskSeverity.Medium,
    title: `Large change: ${changedLines} lines`,
    detail: `Reviews catch fewer problems past about ${LARGE_CHANGE_LINES} changed lines. Consider splitting it, or review it in several sittings.`,
  }
  return [pullRequestFinding(rule)]
}

function missingTestsSignal(files: readonly ChangedFile[]): Risk[] {
  const reviewable = files.filter((file) => file.noise === null)
  const testsChanged = reviewable.some((file) => isTestPath(file.diff.path) || changedUnitsOf(file).some(isTestUnit))
  const codeChanges = reviewable
    .filter((file) => !isTestPath(file.diff.path))
    .flatMap(changedUnitsOf)
    .filter((unit) => isBehaviourChange(unit.change) && !isTestUnit(unit))
  if (testsChanged || codeChanges.length === 0) return []
  const rule: RuleDescription = {
    id: "tests.none",
    category: RiskCategory.Tests,
    severity: RiskSeverity.Medium,
    title: "No tests added or changed",
    detail: `${codeChanges.length} code ${codeChanges.length === 1 ? "unit changes" : "units change"} behaviour, but no test was added or updated. Check how the change is verified.`,
  }
  return [pullRequestFinding(rule)]
}

/** A removed or renamed unit that untouched code still names will likely break the build or fail at runtime. */
function brokenReferenceSignals(files: readonly ChangedFile[]): Risk[] {
  return files.flatMap((file) =>
    changedUnitsOf(file).flatMap((unit) => {
      const gone = unit.change.kind === UnitChangeKind.Removed || unit.change.kind === UnitChangeKind.Renamed
      if (!gone || unit.impact?.status !== UnitImpactStatus.Traced) return []
      // Possible references may be other items sharing the name; they alone do not prove a break.
      const stale = untouchedReferences(unit).filter((reference) => reference.confidence !== ReferenceConfidence.Possible)
      const first = stale.at(0)
      if (first === undefined) return []
      const verb = unit.change.kind === UnitChangeKind.Removed ? "removed" : "renamed"
      const rule: RuleDescription = {
        id: "reference.stale",
        category: RiskCategory.BrokenReference,
        severity: RiskSeverity.High,
        title: `${codeSpan(unit.impact.searchedName)} was ${verb} but is still referenced`,
        detail: `${stale.length} ${stale.length === 1 ? "place" : "places"} this PR did not touch still ${stale.length === 1 ? "uses" : "use"} the old name (from ${file.diff.path}). Unless another item has the same name, this breaks.`,
      }
      return [findingAt(rule, first.path, first.line, first.snippet)]
    }),
  )
}
