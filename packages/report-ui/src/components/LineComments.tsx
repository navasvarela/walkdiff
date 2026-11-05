import { createContext, useContext, useId, useMemo, useState } from "react"
import type { ReactElement, ReactNode } from "react"
import { LineSide } from "@walkdiff/review-model"
import type { ChangedFile } from "@walkdiff/review-model"
import { commentableLines, commentedLinesOf, describeRange, lineCommentKey, lineCommentsIn, lineNumberOf, rangeBetween } from "../lineComments.ts"
import type { CommentableLines } from "../lineComments.ts"
import { useReviewState } from "../reviewState.tsx"

interface Selection {
  readonly side: LineSide
  readonly anchor: number
  readonly focus: number
}

interface LineCommentScope {
  readonly path: string
  readonly lines: CommentableLines
  readonly selection: Selection | undefined
  readonly select: (side: LineSide, line: number, extend: boolean) => void
  readonly clear: () => void
}

// Absent outside a file whose diff the host knows, as in a comparison with an earlier review.
const ScopeContext = createContext<LineCommentScope | undefined>(undefined)

/** Makes the line numbers inside it pickable, for comments on the lines of this file's diff. */
export function LineCommentScopeProvider({ file, children }: { readonly file: ChangedFile; readonly children: ReactNode }): ReactElement {
  const lines = useMemo(() => commentableLines(file.diff), [file.diff])
  const [selection, setSelection] = useState<Selection>()
  const scope = useMemo<LineCommentScope>(
    () => ({
      path: file.diff.path,
      lines,
      selection,
      // Shift-click extends a selection on the same side, as in an editor.
      select: (side, line, extend) => setSelection((current) => (extend && current !== undefined && current.side === side ? { ...current, focus: line } : { side, anchor: line, focus: line })),
      clear: () => setSelection(undefined),
    }),
    [file.diff.path, lines, selection],
  )
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

/** Keeps the lines inside it from being picked, where their numbers aren't the diff's. */
export function WithoutLineComments({ children }: { readonly children: ReactNode }): ReactElement {
  return <ScopeContext.Provider value={undefined}>{children}</ScopeContext.Provider>
}

interface LineNumberCellProps {
  readonly side: LineSide
  readonly line: number | undefined
  readonly className?: string
}

/** A line number, which can be clicked to comment on that line when the host would accept it. */
export function LineNumberCell({ side, line, className = "" }: LineNumberCellProps): ReactElement {
  const scope = useContext(ScopeContext)
  const commented = useCommentedLines(scope?.path)
  const onSide = scope === undefined ? undefined : side === LineSide.Old ? scope.lines.old : scope.lines.new
  if (scope === undefined || line === undefined || onSide === undefined || !onSide.has(line)) {
    return (
      <td className={`line-number ${className}`.trim()} data-side={side} data-line={line}>
        {line}
      </td>
    )
  }
  const selected = scope.selection !== undefined && scope.selection.side === side && line >= Math.min(scope.selection.anchor, scope.selection.focus) && line <= Math.max(scope.selection.anchor, scope.selection.focus)
  const hasComment = commented.has(`${side}:${line}`)
  const classes = ["line-number", className, selected ? "line-number-selected" : "", hasComment ? "line-number-commented" : ""].filter((name) => name !== "").join(" ")
  return (
    <td className={classes} data-side={side} data-line={line}>
      <button type="button" className="line-number-button" title="Comment on this line. Shift-click to pick several." onClick={(event) => scope.select(side, line, event.shiftKey)}>
        {line}
      </button>
    </td>
  )
}

function useCommentedLines(path: string | undefined): ReadonlySet<string> {
  const { state } = useReviewState()
  return useMemo(() => (path === undefined ? new Set<string>() : commentedLinesOf(state.comments, path)), [state.comments, path])
}

/**
 * The comment box for the picked lines, and this file's line comments so far. It stays at the
 * bottom of the screen while lines are picked, so it's in view however long the file is.
 */
export function LineCommentPanel({ file }: { readonly file: ChangedFile }): ReactElement | null {
  const scope = useContext(ScopeContext)
  const { state, setComment } = useReviewState()
  const fieldId = useId()
  const saved = useMemo(() => lineCommentsIn(state.comments, [file]), [state.comments, file])
  if (scope === undefined) return null
  const { selection } = scope
  const range = selection === undefined ? undefined : rangeBetween(scope.lines, selection.side, selection.anchor, selection.focus)
  const key = range === undefined ? undefined : lineCommentKey(scope.path, range)
  return (
    <>
      {saved.length > 0 && (
        <ul className="line-comment-list" aria-label="Your comments on lines of this file">
          {saved.map((comment) => (
            <li key={lineCommentKey(comment.path, comment.range)}>
              <button type="button" className="link-button" onClick={() => {
                scope.select(comment.range.side, lineNumberOf(comment.range.start, comment.range.side), false)
                scope.select(comment.range.side, lineNumberOf(comment.range.end, comment.range.side), true)
              }}>
                {describeRange(comment.range)}
              </button>{" "}
              <span className="line-comment-text">{comment.text}</span>
            </li>
          ))}
        </ul>
      )}
      {selection !== undefined && (
        <div className="line-comment-panel" role="region" aria-label="Comment on lines">
          {key === undefined || range === undefined ? (
            <p className="guide-note">These lines span a gap in the diff, and hosts only take a comment on lines they show together. Pick lines within one block.</p>
          ) : (
            <>
              <label htmlFor={fieldId} className="review-comment-label">
                Your comment on {describeRange(range)}
              </label>
              <textarea id={fieldId} rows={3} autoFocus value={state.comments.get(key) ?? ""} placeholder="What should the author look at here?" onChange={(event) => setComment(key, event.target.value)} />
            </>
          )}
          <div className="line-comment-actions">
            <button type="button" className="guide-button guide-button-primary" onClick={scope.clear}>
              Done
            </button>
            {key !== undefined && (state.comments.get(key) ?? "") !== "" && (
              <button type="button" className="guide-button" onClick={() => {
                setComment(key, "")
                scope.clear()
              }}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
