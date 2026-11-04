import type { ReactElement } from "react"
import { UnitChangeKind, UnitImpactStatus, UnitKind, untouchedReferences } from "@walkdiff/review-model"
import type { ChangedUnit, UnitChange, UnitImpact, UnitSnapshot } from "@walkdiff/review-model"
import { changeLabel, factPhrases, isQuiet, Tone, unitAnchorId, UNIT_KIND_LABELS } from "../unitChange.ts"
import { isItemReviewed } from "../reviewProgress.ts"
import type { ReviewItem } from "../reviewProgress.ts"
import { useReviewState } from "../reviewState.tsx"
import { SideBySide, SinglePane } from "./CodeViews.tsx"
import { ReviewControls } from "./ReviewControls.tsx"

interface UnitCardProps {
  readonly path: string
  readonly unit: ChangedUnit
  /** Identifies this change in the review record, shared with the guided path. */
  readonly item: ReviewItem
  /** Position among the file's cards, which the file map links to. */
  readonly index: number
  readonly onShowImpact: () => void
}

export function UnitCard({ path, unit, item, index, onShowImpact }: UnitCardProps): ReactElement {
  const { state } = useReviewState()
  const label = changeLabel(unit.change)
  const untouchedCallers = untouchedReferences(unit).length
  return (
    <details id={unitAnchorId(index)} className={`unit unit-${label.tone}`} open={!isQuiet(unit)}>
      <summary>
        <span className="unit-kind">{UNIT_KIND_LABELS[unit.kind]}</span>
        {unit.kind !== UnitKind.ModuleScope && <code className="unit-name">{unit.qualifiedName}</code>}
        {untouchedCallers > 0 && (
          <span className="impact-badge" title="Places that use this unit but were not changed by this PR">
            {untouchedCallers} untouched {untouchedCallers === 1 ? "caller" : "callers"}
          </span>
        )}
        {isItemReviewed(item, state) && <span className="unit-reviewed">✓ Reviewed</span>}
        {state.reviewed.has(item.id) && !isItemReviewed(item, state) && <span className="unit-changed">Changed since your review</span>}
        <span className={`change-label tone-${label.tone}`}>{label.text}</span>
      </summary>
      {unit.facts !== null && (
        <ul className="unit-facts" aria-label="What changed">
          {factPhrases(unit.facts).map((phrase) => (
            <li key={phrase}>{phrase}</li>
          ))}
        </ul>
      )}
      <UnitBody path={path} unit={unit} />
      {unit.impact !== null && <ImpactLine unit={unit} impact={unit.impact} onShow={onShowImpact} />}
      {!isQuiet(unit) && (
        <div className="unit-review">
          <ReviewControls items={[item]} commentId={item.id} />
        </div>
      )}
    </details>
  )
}

interface ImpactLineProps {
  readonly unit: ChangedUnit
  readonly impact: UnitImpact
  readonly onShow: () => void
}

/** One line on the card; the full list lives on the Impact tab, so code stays together here. */
function ImpactLine({ unit, impact, onShow }: ImpactLineProps): ReactElement | null {
  const gone = unit.change.kind === UnitChangeKind.Removed || unit.change.kind === UnitChangeKind.Renamed
  if (impact.status !== UnitImpactStatus.Traced) {
    return (
      <p className="impact impact-note">
        Callers not traced.{" "}
        <button type="button" className="link-button" onClick={onShow}>
          Why
        </button>
      </p>
    )
  }
  if (impact.totalReferences === 0) {
    return gone ? <p className="impact impact-note">No remaining references to {impact.searchedName}.</p> : null
  }
  const untouched = untouchedReferences(unit).length
  return (
    <p className={gone && untouched > 0 ? "impact impact-warning" : "impact impact-note"}>
      {gone ? "Still referenced" : "Used"} in {impact.totalReferences} {impact.totalReferences === 1 ? "place" : "places"}
      {untouched > 0 && `, ${untouched} not changed by this PR`}.{" "}
      <button type="button" className="link-button" onClick={onShow}>
        See where
      </button>
    </p>
  )
}

interface UnitBodyProps {
  readonly path: string
  readonly unit: ChangedUnit
}

export function UnitBody({ path, unit }: UnitBodyProps): ReactElement {
  const { change } = unit
  // Collapsed nested units break the link between row and file line number.
  const numbered = !snapshotsOf(change).some((snapshot) => snapshot.elidesNestedUnits)
  switch (change.kind) {
    case UnitChangeKind.Added:
      return <SinglePane path={path} snapshot={change.after} tone={Tone.Added} numbered={numbered} />
    case UnitChangeKind.Removed:
      return <SinglePane path={path} snapshot={change.before} tone={Tone.Removed} numbered={numbered} />
    case UnitChangeKind.MovedOut:
      return (
        <p className="unit-note">
          Now <code>{change.to.qualifiedName}</code> in <code>{change.to.path}</code>, {change.edited ? "with edits you can read there." : "unchanged apart from formatting and comments."}
        </p>
      )
    case UnitChangeKind.Modified:
    case UnitChangeKind.Renamed:
    case UnitChangeKind.MovedIn:
      return <SideBySide path={path} before={change.before} after={change.after} numbered={numbered} />
  }
}

function snapshotsOf(change: UnitChange): UnitSnapshot[] {
  return [..."before" in change ? [change.before] : [], ..."after" in change ? [change.after] : []]
}
