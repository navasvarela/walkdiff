import { useMemo, useState } from "react"
import type { ReactElement } from "react"
import { LineSide } from "@walkdiff/review-model"
import type { UnitSnapshot } from "@walkdiff/review-model"
import { buildRows, numberedLines, wordMarks } from "../lineDiff.ts"
import type { DiffRow, NumberedLine } from "../lineDiff.ts"
import { languageForPath, segmentLine } from "../syntax/highlight.ts"
import type { CodeSegment, LineSpans, TextRange } from "../syntax/highlight.ts"
import { LineNumberCell } from "./LineComments.tsx"
import { Tone } from "../unitChange.ts"

const WORD_ADDED_CLASS = "word-added"
const WORD_REMOVED_CLASS = "word-removed"

interface CodeTextProps {
  readonly text: string
  readonly spans: LineSpans
  readonly marks?: readonly TextRange[]
  readonly markClass?: string
}

/** One line of code. React escapes it as text, so nothing in a PR can become markup. */
export function CodeText({ text, spans, marks = [], markClass }: CodeTextProps): ReactElement {
  return (
    <>
      {segmentLine(text, spans, marks).map((segment, index) => {
        const className = segmentClassName(segment, markClass)
        return className === undefined ? segment.text : <span key={index} className={className}>{segment.text}</span>
      })}
    </>
  )
}

function segmentClassName({ kind, marked }: CodeSegment, markClass: string | undefined): string | undefined {
  const classes = [...(kind === undefined ? [] : ["syntax", `syntax-${kind}`]), ...(marked && markClass !== undefined ? [markClass] : [])]
  return classes.length === 0 ? undefined : classes.join(" ")
}

interface SideBySideProps {
  /** The file the code is from, which decides its colouring. */
  readonly path: string
  readonly before: UnitSnapshot
  readonly after: UnitSnapshot
  readonly numbered: boolean
}

/** The whole unit before and after, aligned, with the changed words marked inside edited lines. */
export function SideBySide({ path, before, after, numbered }: SideBySideProps): ReactElement {
  const rows = useMemo(() => buildRows(before, after, { numbered, language: languageForPath(path) }), [path, before, after, numbered])
  return (
    <table className="code side-by-side">
      <colgroup>
        <col className="line-number-column" />
        <col />
        <col className="line-number-column" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((row, index) => (
          <Row key={index} row={row} />
        ))}
      </tbody>
    </table>
  )
}

function Row({ row }: { readonly row: DiffRow }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  switch (row.kind) {
    case "same":
      return (
        <tr>
          <LineCells line={row.left} side={LineSide.Old} className="" />
          <LineCells line={row.right} side={LineSide.New} className="" />
        </tr>
      )
    case "changed":
      return <ChangedRow left={row.left} right={row.right} />
    case "elided":
      return expanded ? (
        <>
          {row.rows.map((hidden, index) => (
            <Row key={index} row={hidden} />
          ))}
        </>
      ) : (
        <tr className="elided">
          <td colSpan={4}>
            <button type="button" onClick={() => setExpanded(true)}>
              ⋯ {row.rows.length} unchanged lines
            </button>
          </td>
        </tr>
      )
  }
}

interface ChangedRowProps {
  readonly left: NumberedLine | undefined
  readonly right: NumberedLine | undefined
}

function ChangedRow({ left, right }: ChangedRowProps): ReactElement {
  if (left === undefined || right === undefined) {
    return (
      <tr>
        {left === undefined ? <EmptyCells /> : <LineCells line={left} side={LineSide.Old} className="line-removed" />}
        {right === undefined ? <EmptyCells /> : <LineCells line={right} side={LineSide.New} className="line-added" />}
      </tr>
    )
  }
  return <EditedRow left={left} right={right} />
}

interface EditedRowProps {
  readonly left: NumberedLine
  readonly right: NumberedLine
}

function EditedRow({ left, right }: EditedRowProps): ReactElement {
  const marks = useMemo(() => wordMarks(left.text, right.text), [left.text, right.text])
  return (
    <tr>
      <LineNumberCell side={LineSide.Old} line={left.number} />
      <td className="line line-removed">
        <CodeText text={left.text} spans={left.spans} marks={marks.left} markClass={WORD_REMOVED_CLASS} />
      </td>
      <LineNumberCell side={LineSide.New} line={right.number} />
      <td className="line line-added">
        <CodeText text={right.text} spans={right.spans} marks={marks.right} markClass={WORD_ADDED_CLASS} />
      </td>
    </tr>
  )
}

function LineCells({ line, side, className }: { readonly line: NumberedLine; readonly side: LineSide; readonly className: string }): ReactElement {
  return (
    <>
      <LineNumberCell side={side} line={line.number} />
      <td className={`line ${className}`}>
        <CodeText text={line.text} spans={line.spans} />
      </td>
    </>
  )
}

function EmptyCells(): ReactElement {
  return (
    <>
      <td className="line-number empty" />
      <td className="line empty" />
    </>
  )
}

interface SinglePaneProps {
  readonly path: string
  readonly snapshot: UnitSnapshot
  readonly tone: Tone
  readonly numbered: boolean
}

/** One version of a unit, for units that exist on one side only. */
export function SinglePane({ path, snapshot, tone, numbered }: SinglePaneProps): ReactElement {
  const lines = useMemo(() => numberedLines(snapshot, { numbered, language: languageForPath(path) }), [path, snapshot, numbered])
  return (
    <table className="code single-pane">
      <colgroup>
        <col className="line-number-column" />
        <col />
      </colgroup>
      <tbody>
        {lines.map((line, index) => (
          <tr key={index}>
            <LineCells line={line} side={tone === Tone.Removed ? LineSide.Old : LineSide.New} className={`line-${tone}`} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}
