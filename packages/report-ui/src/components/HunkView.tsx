import { useMemo } from "react"
import type { ReactElement } from "react"
import { DiffLineKind, FileContentKind, LineSide } from "@walkdiff/review-model"
import type { DiffLine, FileDiff, Hunk } from "@walkdiff/review-model"
import { highlightHunkLines } from "../lineDiff.ts"
import { languageForPath, MAX_HIGHLIGHT_CHARS, NO_SPANS } from "../syntax/highlight.ts"
import type { HighlightLanguage, LineSpans } from "../syntax/highlight.ts"
import { CodeText } from "./CodeViews.tsx"
import { LineNumberCell } from "./LineComments.tsx"

interface HunkViewProps {
  readonly diff: FileDiff
}

/** Git's own view of the change, for files without unit analysis and as a fallback. */
export function HunkView({ diff }: HunkViewProps): ReactElement {
  if (diff.content.kind === FileContentKind.Binary) {
    return <p className="notice">Binary file; no text diff.</p>
  }
  if (diff.content.hunks.length === 0) {
    return <p className="notice">No content changes (rename or file mode only).</p>
  }
  const { hunks } = diff.content
  // Each hunk is under the limit in a file with many small ones, but the limit protects the whole page.
  const totalChars = hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((lineSum, line) => lineSum + line.content.length, 0), 0)
  const language = totalChars > MAX_HIGHLIGHT_CHARS ? undefined : languageForPath(diff.path)
  return (
    <table className="code hunks">
      <colgroup>
        <col className="line-number-column" />
        <col className="line-number-column" />
        <col />
      </colgroup>
      {hunks.map((hunk) => (
        <HunkRows key={`${hunk.oldStart}-${hunk.newStart}`} hunk={hunk} language={language} />
      ))}
    </table>
  )
}

interface HunkRowsProps {
  readonly hunk: Hunk
  readonly language: HighlightLanguage | undefined
}

function HunkRows({ hunk, language }: HunkRowsProps): ReactElement {
  const spans = useMemo(() => highlightHunkLines(hunk.lines, language), [hunk.lines, language])
  return (
    <tbody>
      <tr className="hunk-header">
        <td colSpan={3}>
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.section}
        </td>
      </tr>
      {hunk.lines.map((line, index) => (
        <LineRow key={index} line={line} spans={spans.at(index) ?? NO_SPANS} />
      ))}
    </tbody>
  )
}

interface LineRowProps {
  readonly line: DiffLine
  readonly spans: LineSpans
}

function LineRow({ line, spans }: LineRowProps): ReactElement {
  switch (line.kind) {
    case DiffLineKind.Context:
      return <Row className="" oldLine={line.oldLine} newLine={line.newLine} marker=" " content={line.content} spans={spans} />
    case DiffLineKind.Added:
      return <Row className="line-added" oldLine={undefined} newLine={line.newLine} marker="+" content={line.content} spans={spans} />
    case DiffLineKind.Removed:
      return <Row className="line-removed" oldLine={line.oldLine} newLine={undefined} marker="-" content={line.content} spans={spans} />
  }
}

interface RowProps {
  readonly className: string
  readonly oldLine: number | undefined
  readonly newLine: number | undefined
  readonly marker: string
  readonly content: string
  readonly spans: LineSpans
}

function Row({ className, oldLine, newLine, marker, content, spans }: RowProps): ReactElement {
  return (
    <tr>
      <LineNumberCell side={LineSide.Old} line={oldLine} />
      <LineNumberCell side={LineSide.New} line={newLine} />
      <td className={`line ${className}`}>
        <span className="marker">{marker}</span>
        <CodeText text={content} spans={spans} />
      </td>
    </tr>
  )
}
