import type { ReactElement } from "react"
import { CheckOutcome, SECURITY_SCAN_LIMITS, securitySummary, summarizeChecks } from "@walkdiff/review-model"
import type { CheckRow, PullRequest, Risk, RiskAssessment } from "@walkdiff/review-model"
import { CATEGORY_LABELS, groupByRule, SEVERITY_LABELS } from "../risks.ts"
import { sourceLineUrl } from "../sourceLinks.ts"
import { HostLink } from "./HostLink.tsx"
import { InlineCode } from "./InlineCode.tsx"

interface RiskViewProps {
  readonly risk: RiskAssessment
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

/** What security checks found, every finding by rule, then what each check found or why it did not run. */
export function RiskView({ risk, pullRequest, onOpenFile }: RiskViewProps): ReactElement {
  return (
    <section className="risk-view">
      <div className={`level-box level-${risk.securityLevel}`}>
        <p className="level-title">
          <strong>{securitySummary(risk.findings)}</strong>
        </p>
        <p className="level-explanation">{SECURITY_SCAN_LIMITS} The Checks table below lists what ran. Code quality findings aren't counted here.</p>
      </div>

      <h2 className="section-title">Risk findings ({risk.findings.length})</h2>
      {risk.findings.length === 0 ? (
        <p className="notice">No findings from the checks that ran.</p>
      ) : (
        <RiskList findings={risk.findings} pullRequest={pullRequest} onOpenFile={onOpenFile} />
      )}

      <h2 className="section-title">Checks</h2>
      <CheckTable risk={risk} />
    </section>
  )
}

function CheckTable({ risk }: { readonly risk: RiskAssessment }): ReactElement {
  return (
    <table className="check-table">
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Result</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {summarizeChecks(risk).map((row) => (
          <tr key={row.name} className={`check-${row.outcome}`}>
            <th scope="row">{row.name}</th>
            <td className="check-result">{resultLabel(row)}</td>
            <td>{row.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function resultLabel(row: CheckRow): string {
  switch (row.outcome) {
    case CheckOutcome.Clean:
      return "✓ No issues"
    case CheckOutcome.Issues:
      return `${row.issues} ${row.issues === 1 ? "issue" : "issues"}`
    case CheckOutcome.NotRun:
      return "⚠ Didn't run"
  }
}

interface RiskListProps {
  readonly findings: readonly Risk[]
  readonly pullRequest: PullRequest
  readonly onOpenFile: ((path: string) => void) | undefined
}

export function RiskList({ findings, pullRequest, onOpenFile }: RiskListProps): ReactElement {
  return (
    <ul className="risk-list">
      {groupByRule(findings).map((group) => {
        const first = group.findings.at(0)
        if (first === undefined) return null
        return (
          <li key={`${group.ruleId}:${group.title}`} className={`risk risk-${first.severity}`}>
            <div className="risk-header">
              <span className={`severity severity-${first.severity}`}>{SEVERITY_LABELS[first.severity]}</span>
              <span className="risk-category">{CATEGORY_LABELS[first.category]}</span>
              <span className="risk-title">
                <InlineCode text={group.title} />
              </span>
              {group.findings.length > 1 && <span className="risk-count">×{group.findings.length}</span>}
            </div>
            <p className="risk-detail">
              <InlineCode text={first.detail} />
            </p>
            <ul className="risk-places">
              {group.findings.map((finding, index) => (
                <RiskPlace key={index} finding={finding} pullRequest={pullRequest} onOpenFile={onOpenFile} />
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}

interface RiskPlaceProps {
  readonly finding: Risk
  readonly pullRequest: PullRequest
  readonly onOpenFile: ((path: string) => void) | undefined
}

function RiskPlace({ finding, pullRequest, onOpenFile }: RiskPlaceProps): ReactElement | null {
  const { location } = finding
  if (location === null) return null
  const label = location.line === null ? location.path : `${location.path}:${location.line}`
  return (
    <li className="risk-place">
      {onOpenFile === undefined ? (
        <code>{label}</code>
      ) : (
        <button type="button" className="link-button" onClick={() => onOpenFile(location.path)}>
          {label}
        </button>
      )}
      {location.line !== null && <HostLink url={sourceLineUrl(pullRequest, location.path, location.line)} />}
      {finding.evidence !== null && <code className="risk-evidence">{finding.evidence}</code>}
    </li>
  )
}
