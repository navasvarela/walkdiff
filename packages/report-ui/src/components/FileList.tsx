import type { ReactElement } from "react"
import { changedUnitsOf, FileChangeStatus } from "@walkdiff/review-model"
import type { ChangedFile, Risk } from "@walkdiff/review-model"
import { fileProgress } from "../reviewProgress.ts"
import { useReviewState } from "../reviewState.tsx"
import { findingsInFile, SEVERITY_LABELS, worstSeverity } from "../risks.ts"
import { summarizeFile } from "../unitChange.ts"

interface StatusBadge {
  readonly letter: string
  readonly label: string
}

const STATUS_BADGES: Readonly<Record<FileChangeStatus, StatusBadge>> = {
  [FileChangeStatus.Added]: { letter: "A", label: "Added" },
  [FileChangeStatus.Modified]: { letter: "M", label: "Modified" },
  [FileChangeStatus.Deleted]: { letter: "D", label: "Deleted" },
  [FileChangeStatus.Renamed]: { letter: "R", label: "Renamed" },
  [FileChangeStatus.Copied]: { letter: "C", label: "Copied" },
}

interface FileListProps {
  readonly files: readonly ChangedFile[]
  readonly findings: readonly Risk[]
  /** Comments in the PR's open threads by file path; empty when the discussion isn't available. */
  readonly commentCounts: ReadonlyMap<string, number>
  readonly selectedPath: string | undefined
  readonly onSelect: (path: string) => void
}

/** Files needing review first; lockfiles, generated and vendored files grouped below. */
export function FileList({ files, findings, commentCounts, selectedPath, onSelect }: FileListProps): ReactElement {
  const reviewable = files.filter((file) => file.noise === null)
  const skippable = files.filter((file) => file.noise !== null)
  return (
    <nav className="file-list" aria-label="Changed files">
      <h3 className="file-group-title">To review ({reviewable.length})</h3>
      <FileGroup files={reviewable} findings={findings} commentCounts={commentCounts} selectedPath={selectedPath} onSelect={onSelect} />
      {skippable.length > 0 && (
        <>
          <h3 className="file-group-title">Skippable ({skippable.length})</h3>
          <FileGroup files={skippable} findings={findings} commentCounts={commentCounts} selectedPath={selectedPath} onSelect={onSelect} />
        </>
      )}
    </nav>
  )
}

interface FileGroupProps {
  readonly files: readonly ChangedFile[]
  readonly findings: readonly Risk[]
  readonly commentCounts: ReadonlyMap<string, number>
  readonly selectedPath: string | undefined
  readonly onSelect: (path: string) => void
}

function FileGroup({ files, findings, commentCounts, selectedPath, onSelect }: FileGroupProps): ReactElement {
  return (
    <ul>
      {files.map((file) => {
        const { diff } = file
        const badge = STATUS_BADGES[diff.status]
        const selected = diff.path === selectedPath
        return (
          <li key={diff.path}>
            <button
              type="button"
              className={selected ? "file selected" : "file"}
              aria-current={selected}
              title={file.noise?.reason}
              onClick={() => onSelect(diff.path)}
            >
              <span className={`status status-${diff.status}`} title={badge.label}>
                {badge.letter}
              </span>
              <span className="path">
                {diff.path}
                <FileHint file={file} />
              </span>
              <CommentCount count={commentCounts.get(diff.path) ?? 0} />
              <FileReviewMark file={file} />
              <RiskBadge findings={findingsInFile(findings, diff.path)} />
              <span className="counts">
                <span className="added">+{diff.additions}</span> <span className="removed">−{diff.deletions}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function CommentCount({ count }: { readonly count: number }): ReactElement | null {
  if (count === 0) return null
  const label = count === 1 ? "1 comment in open threads on the PR" : `${count} comments in open threads on the PR`
  return (
    <span className="file-comment-count" title={label} aria-label={label}>
      <span aria-hidden="true">💬</span> {count}
    </span>
  )
}

/** Shows marking from anywhere in the review, including the guided path. */
function FileReviewMark({ file }: { readonly file: ChangedFile }): ReactElement | null {
  const { state } = useReviewState()
  const { reviewed, total } = fileProgress(file, state)
  if (total === 0 || reviewed === 0) return null
  return reviewed === total ? (
    <span className="file-review-mark file-review-done" title="All changes in this file are reviewed">
      ✓
    </span>
  ) : (
    <span className="file-review-mark" title={`${reviewed} of ${total} changes in this file are reviewed`}>
      {reviewed}/{total}
    </span>
  )
}

function FileHint({ file }: { readonly file: ChangedFile }): ReactElement | null {
  if (file.noise !== null) {
    return <span className="file-hint">{file.noise.kind}</span>
  }
  if (changedUnitsOf(file).length === 0) {
    return null
  }
  const { needsAttention, quiet, untouchedReferences } = summarizeFile(file)
  if (needsAttention === 0) {
    return <span className="file-hint">no behaviour change</span>
  }
  return (
    <span className="file-hint">
      {needsAttention} to review{quiet > 0 ? ` · ${quiet} collapsed` : ""}
      {untouchedReferences > 0 && <span className="file-hint-impact"> · {untouchedReferences} untouched callers</span>}
    </span>
  )
}

function RiskBadge({ findings }: { readonly findings: readonly Risk[] }): ReactElement | null {
  const severity = worstSeverity(findings)
  if (severity === undefined) return null
  return (
    <span className={`severity severity-${severity}`} title={`${findings.length} risk findings, worst: ${SEVERITY_LABELS[severity]}`}>
      {findings.length}
    </span>
  )
}
