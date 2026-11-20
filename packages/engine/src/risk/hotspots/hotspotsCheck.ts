import { AnalysisStep, CheckId, DimensionKind, FileChangeStatus, HistoryUnavailableError, isTestPath, RiskSeverity } from "@walkdiff/review-model"
import type { CheckRun, CommitSha, Dimension, FileCommit, FileHistory, Risk } from "@walkdiff/review-model"
import { ISOLATED_CONFIG_ENV, runGit } from "../../git.ts"
import { languageFor } from "../../languages/registry.ts"
import { isNoiseByPath } from "../../noise.ts"
import type { Check, CheckContext } from "../checks/check.ts"
import { creditedTo } from "../checks/credit.ts"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import { TURNED_OFF_IN_SETTINGS } from "../scanners/scanWorkspace.ts"

/**
 * Hotspots: changed files whose recent history says to look harder, because they keep needing
 * fixes, change far more often than most, or had a change reverted just before this PR. History
 * is read up to the merge base, so the PR's own commits never count.
 *
 * The limits below are judgement calls rather than measured values, chosen so a file has to stand
 * out: a busy project's ordinary files change a few times a month, and a fix now and then is normal.
 */
const HISTORY_DAYS = 365
const RECENT_REVERT_DAYS = 90
const MIN_CHANGES_FOR_CHURN = 30
const MIN_FIXES = 5
const MIN_FIX_SHARE = 0.25
// Each file costs a lookup; past this many, a PR is too broad for "look harder here" to help.
const MAX_FILES = 60
const MS_PER_DAY = 24 * 60 * 60 * 1000

// Conventional prefixes (`fix:`, `fix(parser):`) and plain words both count; maintenance doesn't.
const FIX_SUBJECT = /\b(?:fix(?:e[sd]|ing)?|bug(?:fix)?|hotfix|regression|crash(?:es|ed)?|broken)\b/i
const NOT_A_BUG = /\b(?:typos?|lint(?:ing)?|format(?:ting)?|style|docs?|readme|tests?|ci|build|deps|dependenc(?:y|ies))\b/i
const REVERT_SUBJECT = /^revert\b/i

const HOTSPOT = "hotspot"
const HOTSPOT_DIMENSION: Dimension = { id: HOTSPOT, label: "Hotspot", kind: DimensionKind.Context, advice: "" }
const HOTSPOTS_NAME = "Hotspots"
const HOTSPOTS_RUN: CheckRun = { name: HOTSPOTS_NAME, detail: `each changed file's commits in the ${HISTORY_DAYS} days before this PR` }
const CLOSER_LOOK = "Files like this tend to keep needing fixes, so this change deserves a closer look than its size suggests."

export const HOTSPOTS_CHECK: Check = {
  step: AnalysisStep.CheckingBreakingChanges,
  dimensions: [HOTSPOT_DIMENSION],
  run: async (context) => {
    if (context.request.disabledChecks.has(CheckId.Hotspots)) return { findings: [], checksRun: [], notChecked: [{ check: HOTSPOTS_NAME, reason: TURNED_OFF_IN_SETTINGS }] }
    const candidates = historyCandidates(context).slice(0, MAX_FILES)
    if (candidates.length === 0) return { findings: [], checksRun: [], notChecked: [] }
    const baseDate = await commitDate(context.request.repoDir, context.request.base)
    try {
      const since = new Date(baseDate.getTime() - HISTORY_DAYS * MS_PER_DAY)
      const histories = await context.request.history({ paths: candidates.map((candidate) => candidate.before), until: context.request.base, since })
      const findings = candidates.flatMap(({ before, path }) => {
        const history = histories.get(before)
        const found = history === undefined ? undefined : hotspotFinding(path, history, baseDate)
        return found === undefined ? [] : [found]
      })
      return { findings: creditedTo(HOTSPOTS_NAME, findings), checksRun: [HOTSPOTS_RUN], notChecked: [] }
    } catch (error: unknown) {
      if (!(error instanceof HistoryUnavailableError)) throw error
      return { findings: [], checksRun: [], notChecked: [{ check: HOTSPOTS_NAME, reason: `no history to read: ${error.message}` }] }
    }
  },
}

interface Candidate {
  /** Where the file was at the merge base, whose history is read. */
  readonly before: string
  /** Where it is now, which the finding points at. */
  readonly path: string
}

/** Code files the PR changes that existed before it: a new file has no history to speak of. */
function historyCandidates({ scanned }: CheckContext): Candidate[] {
  return scanned
    .filter(({ diff }) => diff.status !== FileChangeStatus.Added && diff.status !== FileChangeStatus.Deleted)
    .map(({ diff }) => ({ before: diff.status === FileChangeStatus.Renamed ? diff.previousPath : diff.path, path: diff.path }))
    .filter(({ path }) => languageFor(path) !== undefined && !isTestPath(path) && !isNoiseByPath(path))
}

async function commitDate(repoDir: string, commit: CommitSha): Promise<Date> {
  return new Date((await runGit(["show", "-s", "--format=%cI", commit], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })).trim())
}

export function isFix(commit: FileCommit): boolean {
  return FIX_SUBJECT.test(commit.subject) && !NOT_A_BUG.test(commit.subject) && !REVERT_SUBJECT.test(commit.subject)
}

/** A finding for a file whose history stands out, or undefined when it doesn't. */
export function hotspotFinding(path: string, history: FileHistory, baseDate: Date): Risk | undefined {
  const { commits, total } = history
  const fixes = commits.filter(isFix).length
  const authors = new Set(commits.map((commit) => commit.author)).size
  const revert = commits.find((commit) => REVERT_SUBJECT.test(commit.subject) && daysBefore(baseDate, commit.committedAt) <= RECENT_REVERT_DAYS)
  const fixProne = fixes >= MIN_FIXES && fixes / Math.max(commits.length, 1) >= MIN_FIX_SHARE
  const churned = total >= MIN_CHANGES_FOR_CHURN
  if (revert === undefined && !fixProne && !churned) return undefined

  // A host returns a page of commits, so the counts read from them are a floor when there are more.
  const atLeast = commits.length < total ? "at least " : ""
  const facts = `In the year before this PR, ${total} commits by ${atLeast}${authors} ${authors === 1 ? "person" : "people"} changed it, and ${atLeast}${fixes} of them fixed something.`
  const reverted = revert === undefined ? "" : ` ${revert.sha.slice(0, 8)} reverted a change ${describeDaysAgo(daysBefore(baseDate, revert.committedAt))}: "${revert.subject}".`
  const rule: RuleDescription = {
    id: revert !== undefined ? "hotspot.recently-reverted" : fixProne ? "hotspot.fix-prone" : "hotspot.churn",
    category: HOTSPOT,
    severity: RiskSeverity.Low,
    title: revert !== undefined ? "Had a change reverted recently" : fixProne ? `Often fixed: ${atLeast}${fixes} of ${total} changes in the past year` : `Changes often: ${total} commits in the past year`,
    detail: `${facts}${reverted} ${CLOSER_LOOK}`,
  }
  return findingAt(rule, path, null, null)
}

function daysBefore(baseDate: Date, timestamp: string): number {
  return Math.floor((baseDate.getTime() - new Date(timestamp).getTime()) / MS_PER_DAY)
}

function describeDaysAgo(days: number): string {
  if (days <= 1) return "the day before"
  if (days < 14) return `${days} days before`
  return `${Math.round(days / 7)} weeks before`
}
