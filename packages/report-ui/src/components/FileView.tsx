import { useEffect, useRef, useState } from "react"
import type { ReactElement, RefObject } from "react"
import { changedUnitsOf, FileChangeStatus, RiskSeverity, SyntaxAnalysisStatus } from "@walkdiff/review-model"
import type { ChangedFile, PullRequest, Risk, SyntaxAnalysis, UnitRef } from "@walkdiff/review-model"
import { itemsOfFile, unitItem } from "../reviewProgress.ts"
import { worstSeverity } from "../risks.ts"
import type { LinePlace } from "../threadPlaces.ts"
import { summarizeFile } from "../unitChange.ts"
import { FileMap, MIN_UNITS_FOR_MAP } from "./FileMap.tsx"
import { HunkView } from "./HunkView.tsx"
import { LineCommentPanel, LineCommentScopeProvider } from "./LineComments.tsx"
import { ReviewControls } from "./ReviewControls.tsx"
import { RiskList } from "./RiskView.tsx"
import { UnitCard } from "./UnitCard.tsx"

const ViewMode = { Units: "units", Lines: "lines" } as const
type ViewMode = (typeof ViewMode)[keyof typeof ViewMode]

// Long enough to find the line after the scroll ends; the highlight then fades.
const FOCUS_HIGHLIGHT_MS = 2_500
const FOCUSED_ROW_CLASS = "line-focused"

interface FileViewProps {
  readonly file: ChangedFile
  /** Risk findings located in this file. */
  readonly findings: readonly Risk[]
  readonly pullRequest: PullRequest
  readonly onShowImpact: (unit: UnitRef) => void
  /** A line to scroll to on opening, such as one a discussion thread is on. */
  readonly focus: LinePlace | undefined
}

export function FileView({ file, findings, pullRequest, onShowImpact, focus }: FileViewProps): ReactElement {
  const units = changedUnitsOf(file)
  // The line diff shows every line in the diff; the units view can leave the focused one out.
  const [mode, setMode] = useState<ViewMode>(units.length > 0 && focus === undefined ? ViewMode.Units : ViewMode.Lines)
  const { diff } = file
  const items = itemsOfFile(file)
  const sectionRef = useRef<HTMLElement>(null)
  useScrollToLine(sectionRef, focus)

  return (
    <section className="file-view" ref={sectionRef}>
      <header className="file-view-header">
        <h2>
          {diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? (
            <>
              <span className="previous-path">{diff.previousPath}</span> → {diff.path}{" "}
              <span className="similarity">{diff.similarity}% similar</span>
            </>
          ) : (
            diff.path
          )}
        </h2>
        {units.length > 0 && (
          <div className="view-toggle" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === ViewMode.Units} onClick={() => setMode(ViewMode.Units)}>
              Changed units
            </button>
            <button type="button" aria-pressed={mode === ViewMode.Lines} onClick={() => setMode(ViewMode.Lines)}>
              Line diff
            </button>
          </div>
        )}
        {items.length > 0 && <ReviewControls items={items} commentId={units.length === 0 ? items.at(0)?.id : undefined} markLabel={units.length === 0 ? "Mark as reviewed" : "Mark file as reviewed"} />}
      </header>
      {file.noise !== null && (
        <p className="notice">
          Skippable: {file.noise.kind} file ({file.noise.reason}).
        </p>
      )}
      {findings.length > 0 && (
        <details className="file-risks" open={worstSeverity(findings) === RiskSeverity.High}>
          <summary>
            {findings.length} risk {findings.length === 1 ? "finding" : "findings"} in this file
          </summary>
          <RiskList findings={findings} pullRequest={pullRequest} onOpenFile={undefined} />
        </details>
      )}
      <LineCommentScopeProvider file={file}>
        <AnalysisNote syntax={file.syntax} />
        {mode === ViewMode.Units && units.length > 0 ? (
          <>
            <UnitSummary file={file} />
            {file.syntax.status === SyntaxAnalysisStatus.Analyzed && units.length >= MIN_UNITS_FOR_MAP && (
              <FileMap units={units} outline={file.syntax.outline} calls={file.syntax.calls} />
            )}
            {units.map((unit, index) => (
              // Overloads and cfg variants can repeat a name and change, so the index disambiguates.
              <UnitCard key={`${index}:${unit.qualifiedName}`} path={diff.path} unit={unit} item={unitItem(file, unit)} index={index} onShowImpact={() => onShowImpact({ path: diff.path, qualifiedName: unit.qualifiedName })} />
            ))}
          </>
        ) : (
          <HunkView diff={diff} />
        )}
        <LineCommentPanel file={file} />
      </LineCommentScopeProvider>
    </section>
  )
}

function UnitSummary({ file }: { readonly file: ChangedFile }): ReactElement {
  const { needsAttention, quiet } = summarizeFile(file)
  return (
    <p className="unit-summary">
      {needsAttention} {needsAttention === 1 ? "change needs" : "changes need"} review
      {quiet > 0 && `, ${quiet} collapsed (formatting, comments, renames or moves)`}.
    </p>
  )
}

function AnalysisNote({ syntax }: { readonly syntax: SyntaxAnalysis }): ReactElement | null {
  switch (syntax.status) {
    case SyntaxAnalysisStatus.Analyzed:
      return syntax.units.length === 0 ? <p className="notice">No code changes: only whitespace between definitions moved.</p> : null
    case SyntaxAnalysisStatus.Skipped:
      return <p className="notice">Not analyzed: {syntax.reason}. Showing the line diff.</p>
    case SyntaxAnalysisStatus.UnsupportedLanguage:
      return null
  }
}

function useScrollToLine(sectionRef: RefObject<HTMLElement | null>, focus: LinePlace | undefined): void {
  useEffect(() => {
    if (focus === undefined) return undefined
    const row = sectionRef.current?.querySelector(`td[data-side="${focus.side}"][data-line="${focus.line}"]`)?.closest("tr")
    if (row === null || row === undefined) return undefined
    row.scrollIntoView({ block: "center" })
    row.classList.add(FOCUSED_ROW_CLASS)
    const timer = window.setTimeout(() => row.classList.remove(FOCUSED_ROW_CLASS), FOCUS_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [sectionRef, focus])
}
