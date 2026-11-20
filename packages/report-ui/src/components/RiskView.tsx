import { useEffect } from "react"
import type { ReactElement } from "react"
import { CheckOutcome, dimensionOf, SECURITY_SCAN_LIMITS, securitySummary, summarizeChecks, totalsOf } from "@walkdiff/review-model"
import type { CheckRow, Dimension, PullRequest, Risk, RiskAssessment } from "@walkdiff/review-model"
import { CHECKS_SECTION, dimensionSections, KIND_LABELS, kindSummary, overviewHash, overviewSectionFromHash, sectionElementId } from "../overview.ts"
import type { DimensionSection } from "../overview.ts"
import { groupByRule, SEVERITY_LABELS } from "../risks.ts"
import { sourceLineUrl } from "../sourceLinks.ts"
import { HostLink } from "./HostLink.tsx"
import { InlineCode } from "./InlineCode.tsx"

interface RiskViewProps {
  readonly risk: RiskAssessment
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

/**
 * Everything the checks found on one page: a headline, an index of the dimensions with findings
 * that stays in view, a section per dimension, and what each check found or why it didn't run.
 * Each section has a link of its own, such as `#risks/supplyChain`.
 */
export function RiskView({ risk, pullRequest, onOpenFile }: RiskViewProps): ReactElement {
  const sections = dimensionSections(risk)
  useScrollToLinkedSection()
  return (
    <section className="risk-view">
      <div className={`level-box level-${risk.securityLevel}`}>
        <p className="level-title">
          <strong>{securitySummary(risk)}</strong>
        </p>
        <p className="level-explanation">{SECURITY_SCAN_LIMITS} The Checks section lists what ran.</p>
      </div>
      {kindSummary(sections) !== "" && <p className="overview-headline">{kindSummary(sections)}</p>}

      <div className="overview">
        <OverviewIndex sections={sections} risk={risk} />
        <div className="overview-sections">
          {sections.length === 0 && <p className="notice">No findings from the checks that ran.</p>}
          {sections.map((section) => (
            <DimensionSectionView key={section.dimension.id} section={section} dimensions={risk.dimensions} pullRequest={pullRequest} onOpenFile={onOpenFile} />
          ))}
          <section id={sectionElementId(CHECKS_SECTION)} className="overview-section" aria-labelledby={`${sectionElementId(CHECKS_SECTION)}-title`}>
            <h2 id={`${sectionElementId(CHECKS_SECTION)}-title`} className="section-title">
              Checks
            </h2>
            <CheckTable risk={risk} />
          </section>
        </div>
      </div>
    </section>
  )
}

/** Scrolls to the section a link names, on opening and whenever the link changes. */
function useScrollToLinkedSection(): void {
  useEffect(() => {
    const scroll = (): void => {
      const section = overviewSectionFromHash(window.location.hash)
      if (section !== undefined) document.getElementById(sectionElementId(section))?.scrollIntoView({ block: "start" })
    }
    scroll()
    window.addEventListener("hashchange", scroll)
    return () => window.removeEventListener("hashchange", scroll)
  }, [])
}

/** One row per dimension with findings, grouped by kind, then the checks: the page's table of contents. */
function OverviewIndex({ sections, risk }: { readonly sections: readonly DimensionSection[]; readonly risk: RiskAssessment }): ReactElement {
  const kinds = [...new Set(sections.map((section) => section.dimension.kind))]
  const totals = totalsOf(summarizeChecks(risk))
  return (
    <nav className="overview-index" aria-label="Sections of this page">
      {kinds.map((kind) => (
        <div key={kind} className="overview-index-group">
          <h2 className="overview-index-kind">{KIND_LABELS[kind]}</h2>
          <ul>
            {sections
              .filter((section) => section.dimension.kind === kind)
              .map((section) => (
                <li key={section.dimension.id}>
                  <a href={overviewHash(section.dimension.id)}>
                    <span className="overview-index-label">{section.dimension.label}</span>
                    <span className={`severity severity-${section.worst}`}>{section.findings.length}</span>
                  </a>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <div className="overview-index-group">
        <h2 className="overview-index-kind">Coverage</h2>
        <ul>
          <li>
            <a href={overviewHash(CHECKS_SECTION)}>
              <span className="overview-index-label">Checks</span>
              <span className="overview-index-count">{totals.notRun > 0 ? `${totals.notRun} didn't run` : `${totals.clean + totals.withIssues} ran`}</span>
            </a>
          </li>
        </ul>
      </div>
    </nav>
  )
}

interface DimensionSectionProps {
  readonly section: DimensionSection
  readonly dimensions: readonly Dimension[] | undefined
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

function DimensionSectionView({ section, dimensions, pullRequest, onOpenFile }: DimensionSectionProps): ReactElement {
  const id = sectionElementId(section.dimension.id)
  return (
    <section id={id} className="overview-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="section-title">
        {section.dimension.label} <span className="overview-section-count">{section.findings.length}</span>
      </h2>
      {section.dimension.advice !== "" && <p className="overview-advice">{section.dimension.advice}</p>}
      <RiskList findings={section.findings} showsCategory={false} dimensions={dimensions} pullRequest={pullRequest} onOpenFile={onOpenFile} />
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
  /** False inside a section that already names the dimension. */
  readonly showsCategory?: boolean
  /** The report's description of each category; see `dimensionOf`. */
  readonly dimensions: readonly Dimension[] | undefined
  readonly pullRequest: PullRequest
  readonly onOpenFile: ((path: string) => void) | undefined
}

export function RiskList({ findings, showsCategory = true, dimensions, pullRequest, onOpenFile }: RiskListProps): ReactElement {
  return (
    <ul className="risk-list">
      {groupByRule(findings).map((group) => {
        const first = group.findings.at(0)
        if (first === undefined) return null
        return (
          <li key={`${group.ruleId}:${group.title}`} className={`risk risk-${first.severity}`}>
            <div className="risk-header">
              <span className={`severity severity-${first.severity}`}>{SEVERITY_LABELS[first.severity]}</span>
              {showsCategory && <span className="risk-category">{dimensionOf(first.category, dimensions).label}</span>}
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
