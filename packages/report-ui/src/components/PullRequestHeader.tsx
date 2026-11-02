import type { ReactElement } from "react"
import { SECURITY_SCAN_LIMITS, securitySummary } from "@walkdiff/review-model"
import type { ChangedFile, PullRequest, RiskAssessment } from "@walkdiff/review-model"
import { summarizeFile } from "../unitChange.ts"

const SHORT_SHA_LENGTH = 7

interface PullRequestHeaderProps {
  readonly pullRequest: PullRequest
  readonly files: readonly ChangedFile[]
  readonly risk: RiskAssessment
  readonly feedbackUrl: string | null
}

export function PullRequestHeader({ pullRequest, files, risk, feedbackUrl }: PullRequestHeaderProps): ReactElement {
  const additions = files.reduce((sum, file) => sum + file.diff.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.diff.deletions, 0)
  const quiet = files.map(summarizeFile).reduce((sum, summary) => sum + summary.quiet, 0)
  const skippable = files.filter((file) => file.noise !== null).length
  const notes = [
    ...(quiet > 0 ? [`${quiet} collapsed as formatting, comments, renames or moves`] : []),
    ...(skippable > 0 ? [`${skippable} skippable ${skippable === 1 ? "file" : "files"}`] : []),
  ]

  return (
    <header className="header">
      <h1>
        <span className={`level-badge level-${risk.securityLevel}`} title={SECURITY_SCAN_LIMITS}>
          {securitySummary(risk.findings)}
        </span>{" "}
        {pullRequest.title}{" "}
        <a href={pullRequest.url} target="_blank" rel="noreferrer">
          #{pullRequest.number}
        </a>
      </h1>
      <p className="meta">
        <strong>{pullRequest.author}</strong> wants to merge <code>{pullRequest.headRef}</code> into{" "}
        <code>{pullRequest.baseRef}</code> · {files.length} files · <span className="added">+{additions}</span>{" "}
        <span className="removed">−{deletions}</span> · diff {pullRequest.mergeBaseSha.slice(0, SHORT_SHA_LENGTH)}..
        {pullRequest.headSha.slice(0, SHORT_SHA_LENGTH)}
      </p>
      {(notes.length > 0 || feedbackUrl !== null) && (
        <p className="meta">
          {notes.join(" · ")}
          {notes.length > 0 && feedbackUrl !== null && " · "}
          {feedbackUrl !== null && (
            <a href={feedbackUrl} target="_blank" rel="noreferrer">
              Leave feedback
            </a>
          )}
        </p>
      )}
    </header>
  )
}

/** Only the local app adds this, so a report opened from a file or CI artifact has no link. */
export function homeUrl(): string | undefined {
  return document.querySelector('meta[name="walkdiff-home"]')?.getAttribute("content") ?? undefined
}
