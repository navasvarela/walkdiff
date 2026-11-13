import type { ReactElement } from "react"
import { ReferenceConfidence, UnitChangeKind, UnitImpactStatus } from "@walkdiff/review-model"
import type { ChangedUnit, PullRequest, Reference, UnitImpact } from "@walkdiff/review-model"
import { sourceLineUrl } from "../sourceLinks.ts"
import { SourceLocation } from "./HostLink.tsx"

const CONFIDENCE_LABELS: Readonly<Record<ReferenceConfidence, string>> = {
  [ReferenceConfidence.Exact]: "exact",
  [ReferenceConfidence.Likely]: "likely",
  [ReferenceConfidence.Possible]: "possible",
}

const CONFIDENCE_HINTS: Readonly<Record<ReferenceConfidence, string>> = {
  [ReferenceConfidence.Exact]: "Qualified with the unit's own type or class",
  [ReferenceConfidence.Likely]: "Uses the unit's name directly",
  [ReferenceConfidence.Possible]: "A call or access by name on a value of unknown type; may be another item with the same name",
}

interface ImpactPanelProps {
  readonly unit: ChangedUnit
  readonly impact: UnitImpact
  readonly pullRequest: PullRequest
}

/** Where the rest of the code still depends on a changed, removed or renamed unit. */
export function ImpactPanel({ unit, impact, pullRequest }: ImpactPanelProps): ReactElement {
  if (impact.status === UnitImpactStatus.Skipped) {
    return (
      <p className="impact impact-note">
        Callers of <code>{impact.searchedName}</code> were not traced: {impact.reason}.
      </p>
    )
  }
  if (impact.status === UnitImpactStatus.TooCommon) {
    return (
      <p className="impact impact-note">
        <code>{impact.searchedName}</code> appears in {impact.matchingFiles} files, too common to trace callers by name.
      </p>
    )
  }

  const goneFromHead = unit.change.kind === UnitChangeKind.Removed || unit.change.kind === UnitChangeKind.Renamed
  if (impact.totalReferences === 0) {
    return (
      <p className="impact impact-note">
        {goneFromHead ? (
          <>
            No remaining references to <code>{impact.searchedName}</code>.
          </>
        ) : (
          "No callers found outside the unit itself."
        )}
      </p>
    )
  }

  const untouched = impact.references.filter((reference) => !reference.touchedByPullRequest)
  const touched = impact.references.filter((reference) => reference.touchedByPullRequest)
  const hidden = impact.totalReferences - impact.references.length
  return (
    <div className={goneFromHead ? "impact impact-warning" : "impact"}>
      <p className="impact-title">
        {goneFromHead ? (
          <>
            <code>{impact.searchedName}</code> is still referenced in {impact.totalReferences}{" "}
            {impact.totalReferences === 1 ? "place" : "places"}
          </>
        ) : (
          <>
            Used in {impact.totalReferences} {impact.totalReferences === 1 ? "place" : "places"}
          </>
        )}
        {untouched.length > 0 && <> · {untouched.length} not changed by this PR</>}
      </p>
      {untouched.length > 0 && <ReferenceList references={untouched} pullRequest={pullRequest} />}
      {touched.length > 0 && (
        <details className="impact-touched">
          <summary>{touched.length} updated in this PR</summary>
          <ReferenceList references={touched} pullRequest={pullRequest} />
        </details>
      )}
      {hidden > 0 && <p className="impact-more">{hidden} more not shown.</p>}
    </div>
  )
}

interface ReferenceListProps {
  readonly references: readonly Reference[]
  readonly pullRequest: PullRequest
}

function ReferenceList({ references, pullRequest }: ReferenceListProps): ReactElement {
  return (
    <ul className="reference-list">
      {references.map((reference) => (
        <li key={`${reference.path}:${reference.line}:${reference.snippet}`} className="reference">
          <span className={`confidence confidence-${reference.confidence}`} title={CONFIDENCE_HINTS[reference.confidence]}>
            {CONFIDENCE_LABELS[reference.confidence]}
          </span>
          <SourceLocation url={sourceLineUrl(pullRequest, reference.path, reference.line)}>
            {reference.path}:{reference.line}
          </SourceLocation>
          {reference.callerQualifiedName !== null && <span className="reference-caller">in {reference.callerQualifiedName}</span>}
          <code className="reference-snippet">{reference.snippet}</code>
        </li>
      ))}
    </ul>
  )
}
