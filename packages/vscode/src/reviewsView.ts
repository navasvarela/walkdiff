import { ReviewStatus, RiskSeverity } from "@walkdiff/review-model"
import type { ReviewSummary, Risk } from "@walkdiff/review-model"
import * as vscode from "vscode"
import type { AppSession } from "./appSession.ts"
import type { ReportCache } from "./reportCache.ts"
import { changedFileUri } from "./changedFileContent.ts"
import { FileSide } from "./appClient.ts"
import { changedFileRows, findingLabel, isAnalyzing, pullRequestFindings, reviewRow } from "./reviewRows.ts"
import type { ChangedFileRow } from "./reviewRows.ts"

// Analyses take from seconds to minutes; checking every couple of seconds keeps the step shown current.
const POLL_MS = 2_000
export const OPEN_CHANGE_COMMAND = "walkdiff.openChange"
const OPEN_REVIEW_COMMAND = "walkdiff.openReview"
const OPEN_REPORT_CHOICE = "Open Report"

export interface ReviewNode {
  readonly kind: "review"
  readonly review: ReviewSummary
}
interface FileNode {
  readonly kind: "file"
  readonly review: ReviewSummary
  readonly row: ChangedFileRow
}
interface FindingNode {
  readonly kind: "finding"
  readonly review: ReviewSummary
  readonly finding: Risk
  /** The changed file it points into; undefined for findings about the PR as a whole or other files. */
  readonly row: ChangedFileRow | undefined
}
interface PullRequestFindingsNode {
  readonly kind: "pullRequestFindings"
  readonly review: ReviewSummary
  readonly findings: readonly Risk[]
}
type Node = ReviewNode | FileNode | FindingNode | PullRequestFindingsNode

/** What `walkdiff.openChange` opens: one changed file, at a finding's line when there is one. */
export interface ChangeToOpen {
  readonly review: ReviewSummary
  readonly path: string
  readonly basePath: string
  readonly line: number | undefined
}

/** The app's reviews, each ready one opening onto its changed files and their findings. */
export class ReviewsView implements vscode.TreeDataProvider<Node> {
  readonly #session: AppSession
  readonly #changed = new vscode.EventEmitter<Node | undefined>()
  readonly #reports: ReportCache
  #statuses = new Map<number, ReviewStatus>()
  #poll: ReturnType<typeof setTimeout> | undefined
  readonly onDidChangeTreeData = this.#changed.event
  readonly openReport: (review: ReviewSummary) => Promise<void>

  constructor(session: AppSession, reports: ReportCache, openReport: (review: ReviewSummary) => Promise<void>) {
    this.#session = session
    this.#reports = reports
    this.openReport = openReport
  }

  refresh(): void {
    this.#changed.fire(undefined)
  }

  dispose(): void {
    clearTimeout(this.#poll)
    this.#changed.dispose()
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) return this.#reviews()
    if (node.kind === "review") return this.#reviewChildren(node.review)
    if (node.kind === "file") return node.row.findings.map((finding) => ({ kind: "finding", review: node.review, finding, row: node.row }))
    if (node.kind === "pullRequestFindings") return node.findings.map((finding) => ({ kind: "finding", review: node.review, finding, row: undefined }))
    return []
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "review":
        return reviewItem(node.review)
      case "file":
        return fileItem(node.review, node.row)
      case "finding":
        return findingItem(node)
      case "pullRequestFindings":
        return pullRequestFindingsItem(node)
    }
  }

  /** Reviews from the app, or none while it isn't running, which shows the view's welcome text. */
  async #reviews(): Promise<Node[]> {
    const client = await this.#session.existing()
    if (client === undefined) return []
    const reviews = await client.reviews()
    this.#announceReady(reviews)
    clearTimeout(this.#poll)
    if (isAnalyzing(reviews)) this.#poll = setTimeout(() => this.refresh(), POLL_MS)
    return reviews.map((review) => ({ kind: "review", review }))
  }

  async #reviewChildren(review: ReviewSummary): Promise<Node[]> {
    if (!review.hasReport) return []
    const report = await this.#reports.current(review)
    const wholePullRequest = pullRequestFindings(report)
    const files = changedFileRows(report).map((row): Node => ({ kind: "file", review, row }))
    return wholePullRequest.length === 0 ? files : [{ kind: "pullRequestFindings", review, findings: wholePullRequest }, ...files]
  }

  /** Tells the user when an analysis they're waiting for finishes. */
  #announceReady(reviews: readonly ReviewSummary[]): void {
    const finished = reviews.filter((review) => review.status === ReviewStatus.Ready && isRunning(this.#statuses.get(review.id)))
    this.#statuses = new Map(reviews.map((review) => [review.id, review.status]))
    for (const review of finished) {
      void vscode.window.showInformationMessage(`${review.displayName} is ready to review.`, OPEN_REPORT_CHOICE).then((choice) => (choice === OPEN_REPORT_CHOICE ? this.openReport(review) : undefined))
    }
  }
}

function isRunning(status: ReviewStatus | undefined): boolean {
  return status === ReviewStatus.Queued || status === ReviewStatus.Analyzing
}

function reviewItem(review: ReviewSummary): vscode.TreeItem {
  const row = reviewRow(review)
  const item = new vscode.TreeItem(row.label, review.hasReport ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
  item.id = `review-${review.id}-${review.updatedAt}`
  item.description = row.description
  item.tooltip = row.tooltip
  item.contextValue = row.contextValue
  item.iconPath = reviewIcon(review)
  if (review.hasReport) item.command = { title: "Open Review", command: OPEN_REVIEW_COMMAND, arguments: [{ kind: "review", review }] }
  return item
}

function reviewIcon(review: ReviewSummary): vscode.ThemeIcon {
  switch (review.status) {
    case ReviewStatus.Queued:
      return new vscode.ThemeIcon("clock")
    case ReviewStatus.Analyzing:
      return new vscode.ThemeIcon("loading~spin")
    case ReviewStatus.Failed:
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"))
    case ReviewStatus.Ready:
      return review.securityLevel === null ? new vscode.ThemeIcon("git-pull-request") : severityIcon(review.securityLevel, "git-pull-request")
  }
}

function severityIcon(severity: RiskSeverity, lowIcon: string): vscode.ThemeIcon {
  switch (severity) {
    case RiskSeverity.High:
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"))
    case RiskSeverity.Medium:
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
    case RiskSeverity.Low:
      return new vscode.ThemeIcon(lowIcon)
  }
}

function fileItem(review: ReviewSummary, row: ChangedFileRow): vscode.TreeItem {
  const item = new vscode.TreeItem(changedFileUri(review.id, FileSide.Head, row.path), row.findings.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed)
  item.label = row.path
  item.description = row.description
  item.command = openChange({ review, path: row.path, basePath: row.basePath, line: undefined })
  return item
}

function findingItem({ review, finding, row }: FindingNode): vscode.TreeItem {
  const item = new vscode.TreeItem(findingLabel(finding), vscode.TreeItemCollapsibleState.None)
  const { location } = finding
  if (location !== null) item.description = `${location.path}${location.line === null ? "" : `:${location.line}`}`
  item.tooltip = new vscode.MarkdownString().appendMarkdown(`**${finding.title}**\n\n`).appendText(finding.detail)
  if (finding.evidence !== null) item.tooltip.appendCodeblock(finding.evidence)
  item.iconPath = severityIcon(finding.severity, "info")
  if (row !== undefined) item.command = openChange({ review, path: row.path, basePath: row.basePath, line: location?.line ?? undefined })
  return item
}

function pullRequestFindingsItem(node: PullRequestFindingsNode): vscode.TreeItem {
  const item = new vscode.TreeItem("Whole pull request", vscode.TreeItemCollapsibleState.Expanded)
  item.description = `${node.findings.length}`
  item.iconPath = new vscode.ThemeIcon("git-pull-request")
  return item
}

function openChange(change: ChangeToOpen): vscode.Command {
  return { title: "Open Change", command: OPEN_CHANGE_COMMAND, arguments: [change] }
}
