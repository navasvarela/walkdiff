import { changedUnitsOf, DiffLineKind, FileContentKind, FileChangeStatus, isBehaviourChange, RiskCategory, RiskSeverity, UnitChangeKind, UnitImpactStatus, UnitKind, untouchedReferences } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, ReviewModel, Risk, TestCoverage, UnitChange } from "@walkdiff/review-model"

/*
 * Turns a review into a guided path. The rules are plain points rather than a model, so every
 * position can be explained to the reviewer in words. The values were tuned by hand against
 * three real PRs (a large feature, a Rust refactor and a Python API change). They only need to
 * keep the order sensible: what matters is that a high finding outranks everything, that code
 * other people depend on outranks new code nobody calls yet, and that a typical PR ends up
 * with a short path. Changing them moves functions between "on the path" and "lower priority".
 */
const POINTS_FOR_FINDING: Readonly<Record<RiskSeverity, number>> = {
  [RiskSeverity.High]: 100,
  [RiskSeverity.Medium]: 40,
  [RiskSeverity.Low]: 10,
}
const POINTS_FOR_CODE_QUALITY = 10
// On top of the severity: a "may break" outranks an ordinary medium finding, since other people's code
// or a deployment depends on it, but it stays below any high finding.
const POINTS_FOR_BREAKING_CHANGE = 15
// Several small findings in one place are one decision, so they must not outrank a serious one.
const POINTS_PER_EXTRA_FINDING = 5
const MAX_EXTRA_FINDINGS_COUNTED = 2
const POINTS_FOR_LEFTOVER_REFERENCES = 60
const POINTS_PER_UNTOUCHED_CALLER = 5
const MAX_POINTS_FOR_CALLERS = 40
const POINTS_FOR_SIGNATURE_CHANGE = 15
const POINTS_FOR_CHANGED_EXISTING_CODE = 15
const POINTS_FOR_MORE_LOGIC = 8
const POINTS_FOR_SENSITIVE_FILE = 15
const POINTS_FOR_NO_RELATED_TESTS = 5
/** A change below this has nothing specific to draw attention to. */
const POINTS_TO_BE_ON_THE_PATH = 20
// Evidence that none of a change ran in tests is reason enough on its own to look at it: a bug
// there has nothing to catch it. Below this, an untested new function with no callers yet fell
// off the path, though it's the code a reviewer most needs to read.
const POINTS_FOR_UNTESTED_LINES = POINTS_TO_BE_ON_THE_PATH + 5
const POINTS_FOR_PARTLY_TESTED_LINES = 8
// At or above this share of a change's lines not running, it counts as untested. V8 coverage,
// which c8 and Jest report, marks a function's declaration line as run whenever its module
// loads, so a function no test calls shows one line run, not none.
const MOSTLY_UNTESTED_SHARE = 0.5
// Below untested lines: a report can also leave a file out because it covers only part of a
// monorepo. Still enough for the path, since a new file no test loads is the likelier reason.
const POINTS_FOR_FILE_NOT_IN_COVERAGE = POINTS_TO_BE_ON_THE_PATH
const POINTS_FOR_LARGE_NEW_CODE = 10
const LARGE_NEW_CODE_LINES = 25
// Past about fifteen stops a path stops feeling like a path. The rest stay one click away.
const MAX_STOPS = 15
// A PR of only new, uncalled code scores low everywhere, but a reviewer still needs a start.
const MIN_STOPS = 3
const MAX_REASONS_SHOWN = 3
const MAX_CHECKS = 3
const MIN_NAME_LENGTH_TO_MATCH_IN_TESTS = 3

/**
 * What puts a change on the path, most important first, in the reviewer's words. Keep this in step
 * with `scoreUnit`: a reviewer relies on it to judge what they may have skipped.
 */
export const PATH_RULES: readonly string[] = [
  "Security findings and breaking changes. These are always on the path, however many there are.",
  "Removed code that places this PR didn't change still use.",
  "Code used by places this PR didn't change. The more places, the higher it ranks.",
  "Lines that didn't run in tests, when there's a coverage report.",
  "A changed signature, error handling or branching.",
  "Changes in a sensitive area, and large pieces of new code.",
  "Other edits to existing code, with a small boost if no changed test mentions them.",
]

/**
 * Definitions rather than logic. Adding a value to an enum or a field to a struct can touch many
 * users without changing what any of them do, so these count for less than functions do.
 */
const DATA_KINDS: ReadonlySet<UnitKind> = new Set([UnitKind.Constant, UnitKind.Enum, UnitKind.Struct, UnitKind.TypeAlias, UnitKind.Interface])
const DATA_KIND_CALLER_DIVISOR = 3

/**
 * The brief's checks are decisions about risk. Size has its own note, and code quality shows as
 * a reason at each stop, so a PR with many lint findings can't push a security check out.
 */
const CATEGORIES_NOT_IN_CHECKS: ReadonlySet<RiskCategory> = new Set([RiskCategory.Size, RiskCategory.CodeQuality])

const FIRST_SENTENCE = /^.+?[.!?](?=\s|$)/
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testing)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i
const TEST_UNIT = /(^|::|\.)tests?(::|\.)|(^|::|\.)test_/

export interface ReviewStop {
  /** Null for a file without functions to show, such as a CI pipeline. */
  readonly unit: ChangedUnit | null
  readonly file: ChangedFile
  readonly title: string
  readonly reasons: readonly string[]
  readonly points: number
  readonly findings: readonly Risk[]
  /** Changed test files that mention this function: a hint, not proof that it is tested. */
  readonly relatedTests: readonly string[]
  /** Null without a coverage report, or when the report says nothing about these lines. */
  readonly coverage: StopCoverage | null
}

export const StopCoverageKind = { Lines: "lines", FileNotInReport: "fileNotInReport" } as const

/** Whether the lines this change added ran in tests. */
export interface LineCoverage {
  readonly kind: typeof StopCoverageKind.Lines
  readonly coveredLines: readonly number[]
  readonly uncoveredLines: readonly number[]
}

/**
 * The report covers other files in this language but not this one. Tools such as c8 and
 * Jest list only the files tests loaded, so a new file no test imports is simply missing.
 */
export interface FileNotInCoverage {
  readonly kind: typeof StopCoverageKind.FileNotInReport
}

export type StopCoverage = LineCoverage | FileNotInCoverage

export interface ReviewCheck {
  readonly severity: RiskSeverity
  readonly message: string
  /** Where on the path this can be looked at, when it has a place there. */
  readonly stopIndex: number | undefined
}

export interface LowerPriority {
  readonly newCode: number
  readonly otherCode: number
  readonly quiet: number
  readonly testFiles: number
  readonly otherFiles: number
}

export interface ReviewPlan {
  readonly stops: readonly ReviewStop[]
  readonly checks: readonly ReviewCheck[]
  /** Findings beyond those in `checks`, which are in the full list. */
  readonly moreChecks: number
  readonly lowerPriority: LowerPriority
  readonly lowerPriorityTotal: number
  /** Changes that earned a place but are past the path's limit; none of them has a finding. */
  readonly pastTheLimit: number
  /** Findings in places the path doesn't visit, such as test files. They need their own look. */
  readonly findingsOffPath: number
  readonly sizeNote: string | null
}

export function buildReviewPlan(review: ReviewModel): ReviewPlan {
  const reviewable = review.files.filter((file) => file.noise === null)
  const testFiles = reviewable.filter((file) => isTestPath(file.diff.path))
  const candidates = reviewable
    .filter((file) => !isTestPath(file.diff.path))
    .flatMap((file) => stopsForFile(file, review.risk.findings, testFiles, review.testCoverage))
    .sort((a, b) => b.points - a.points || a.file.diff.path.localeCompare(b.file.diff.path))
  const qualifying = candidates.filter((stop) => stop.points >= POINTS_TO_BE_ON_THE_PATH).length
  const limit = Math.min(MAX_STOPS, Math.max(qualifying, MIN_STOPS))
  // The limit keeps a path short, but must never be why a flagged change goes unseen.
  const stops = candidates.filter((stop, index) => index < limit || isFlagged(stop))
  const groups = groupChecks(review.risk.findings, stops)
  const lowerPriority = summarizeLowerPriority(review.files, stops, testFiles.length)
  return {
    stops,
    checks: groups.slice(0, MAX_CHECKS),
    moreChecks: Math.max(0, groups.length - MAX_CHECKS),
    lowerPriority,
    lowerPriorityTotal: lowerPriority.newCode + lowerPriority.otherCode + lowerPriority.quiet + lowerPriority.testFiles + lowerPriority.otherFiles,
    pastTheLimit: Math.max(0, qualifying - stops.filter((stop) => stop.points >= POINTS_TO_BE_ON_THE_PATH).length),
    findingsOffPath: countFindingsOffPath(review.risk.findings, stops),
    sizeNote: review.risk.findings.find((finding) => finding.category === RiskCategory.Size)?.title ?? null,
  }
}

function isFlagged(stop: ReviewStop): boolean {
  return stop.findings.some((finding) => !CATEGORIES_NOT_IN_CHECKS.has(finding.category))
}

function countFindingsOffPath(findings: readonly Risk[], stops: readonly ReviewStop[]): number {
  const visited = new Set(stops.flatMap((stop) => stop.findings))
  // A finding about the whole PR, such as no tests changed, has no place to visit, so the path
  // isn't missing it. The brief's checks already show it.
  return findings.filter((finding) => finding.location !== null && !CATEGORIES_NOT_IN_CHECKS.has(finding.category) && !visited.has(finding)).length
}

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

export function isTestUnit(unit: ChangedUnit): boolean {
  return TEST_UNIT.test(unit.qualifiedName)
}

function isOnThePathKind(unit: ChangedUnit, findings: readonly Risk[]): boolean {
  if (isTestUnit(unit)) return false
  // A rename changes no behaviour, but it can still break whoever calls the old name.
  return isBehaviourChange(unit.change) || findings.some((finding) => finding.category === RiskCategory.BreakingChange && finding.unit === unit.qualifiedName)
}

/** A stop for one change, on request: used for work that belongs on the path whatever its rank. */
export function stopFor(review: ReviewModel, file: ChangedFile, unit: ChangedUnit | null): ReviewStop {
  const inFile = review.risk.findings.filter((finding) => finding.location?.path === file.diff.path && finding.category !== RiskCategory.Size)
  const stop = unit === null ? stopForWholeFile(file, inFile) : buildUnitStop(unit, file, inFile, review.files.filter((other) => other.noise === null && isTestPath(other.diff.path)), review.testCoverage)
  return { ...stop, reasons: [] }
}

function stopsForFile(file: ChangedFile, findings: readonly Risk[], testFiles: readonly ChangedFile[], coverage: TestCoverage | null): ReviewStop[] {
  const inFile = findings.filter((finding) => finding.location?.path === file.diff.path && finding.category !== RiskCategory.Size)
  const units = changedUnitsOf(file).filter((unit) => isOnThePathKind(unit, inFile))
  if (units.length > 0) return units.flatMap((unit) => stopForUnit(unit, file, inFile, testFiles, coverage))
  return inFile.length === 0 ? [] : [stopForWholeFile(file, inFile)]
}

function stopForWholeFile(file: ChangedFile, findings: readonly Risk[]): ReviewStop {
  const points = pointsForFindings(findings)
  return { unit: null, file, title: file.diff.path, reasons: reasonsFromFindings(findings), points, findings, relatedTests: [], coverage: null }
}

function stopForUnit(unit: ChangedUnit, file: ChangedFile, inFile: readonly Risk[], testFiles: readonly ChangedFile[], coverage: TestCoverage | null): ReviewStop[] {
  const stop = buildUnitStop(unit, file, inFile, testFiles, coverage)
  // Top-level code has no story of its own, so it only appears when something is wrong with it.
  return unit.kind === UnitKind.ModuleScope && stop.findings.length === 0 ? [] : [stop]
}

function buildUnitStop(unit: ChangedUnit, file: ChangedFile, inFile: readonly Risk[], testFiles: readonly ChangedFile[], coverage: TestCoverage | null): ReviewStop {
  const findings = inFile.filter((finding) => findingIsInUnit(finding, unit))
  const relatedTests = testFilesMentioning(unit, file, testFiles)
  const lineCoverage = coverageOfUnit(unit, file, coverage)
  const scored = scoreUnit(unit, findings, inFile, relatedTests, lineCoverage)
  return { unit, file, title: unit.kind === UnitKind.ModuleScope ? "Imports and top-level code" : unit.qualifiedName, reasons: scored.reasons.slice(0, MAX_REASONS_SHOWN), points: scored.points, findings, relatedTests, coverage: lineCoverage }
}

function coverageOfUnit(unit: ChangedUnit, file: ChangedFile, coverage: TestCoverage | null): StopCoverage | null {
  if (coverage === null || !("after" in unit.change)) return null
  const lines = coverage.files.find((entry) => entry.path === file.diff.path)
  if (lines === undefined) return reportCoversLanguageOf(coverage, file.diff.path) ? { kind: StopCoverageKind.FileNotInReport } : null
  const { startLine, endLine } = unit.change.after
  const inUnit = (line: number): boolean => line >= startLine && line <= endLine
  const result = { kind: StopCoverageKind.Lines, coveredLines: lines.coveredLines.filter(inUnit), uncoveredLines: lines.uncoveredLines.filter(inUnit) }
  return result.coveredLines.length + result.uncoveredLines.length === 0 ? null : result
}

// Tests are never in their own coverage report, and a report for another language says nothing.
function reportCoversLanguageOf(coverage: TestCoverage, path: string): boolean {
  const extension = extensionOf(path)
  return !isTestPath(path) && extension !== "" && coverage.files.some((entry) => extensionOf(entry.path) === extension)
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot).toLowerCase()
}

function findingIsInUnit(finding: Risk, unit: ChangedUnit): boolean {
  if (finding.unit !== undefined) return finding.unit === unit.qualifiedName
  const line = finding.location?.line
  if (line === null || line === undefined || !("after" in unit.change)) return false
  return line >= unit.change.after.startLine && line <= unit.change.after.endLine
}

interface Scored {
  readonly points: number
  readonly reasons: readonly string[]
}

// Reasons are collected most important first, as only the first few are shown.
function scoreUnit(unit: ChangedUnit, findings: readonly Risk[], inFile: readonly Risk[], relatedTests: readonly string[], coverage: StopCoverage | null): Scored {
  let points = pointsForFindings(findings)
  const reasons = reasonsFromFindings(findings)
  const add = (amount: number, reason: string): void => {
    points += amount
    reasons.push(reason)
  }
  const isData = DATA_KINDS.has(unit.kind)

  const untouched = untouchedReferences(unit).length
  const gone = unit.change.kind === UnitChangeKind.Removed
  if (gone && untouched > 0) add(POINTS_FOR_LEFTOVER_REFERENCES, `It was removed, but ${places(untouched)} this PR didn't change still ${untouched === 1 ? "uses" : "use"} it`)
  else if (untouched > 0) add(Math.min(MAX_POINTS_FOR_CALLERS, untouched * POINTS_PER_UNTOUCHED_CALLER) / (isData ? DATA_KIND_CALLER_DIVISOR : 1), `${capitalize(places(untouched))} this PR didn't change ${untouched === 1 ? "depends" : "depend"} on it`)

  if (coverage?.kind === StopCoverageKind.FileNotInReport) add(POINTS_FOR_FILE_NOT_IN_COVERAGE, "Its file isn't in the coverage report, so no test may have loaded it")
  else if (coverage !== null && coverage.uncoveredLines.length > 0) {
    const total = coverage.coveredLines.length + coverage.uncoveredLines.length
    const reason = coverage.coveredLines.length === 0 ? `None of its ${total} changed ${total === 1 ? "line" : "lines"} ran in tests` : `${coverage.uncoveredLines.length} of its ${total} changed lines didn't run in tests`
    add(coverage.uncoveredLines.length / total >= MOSTLY_UNTESTED_SHARE ? POINTS_FOR_UNTESTED_LINES : POINTS_FOR_PARTLY_TESTED_LINES, reason)
  }

  const facts = unit.facts
  if (facts !== null) {
    const signature = facts.parametersAdded.length + facts.parametersRemoved.length + facts.parametersChanged.length > 0 || facts.returnType !== null
    if (signature) add(POINTS_FOR_SIGNATURE_CHANGE, "Its signature changed")
    if (facts.branchesDelta > 0 || facts.errorPathsDelta !== 0) add(POINTS_FOR_MORE_LOGIC, facts.errorPathsDelta !== 0 ? "Its error handling changed" : "It has more branching logic")
  }
  // These count but aren't given as reasons: nearly every stop has them, so they say nothing.
  // The stop shows its tests separately.
  if (isEditOfExistingCode(unit.change) && !isData) {
    points += POINTS_FOR_CHANGED_EXISTING_CODE
    if (relatedTests.length === 0) points += POINTS_FOR_NO_RELATED_TESTS
  }
  if (unit.change.kind === UnitChangeKind.Added && unit.change.after.endLine - unit.change.after.startLine >= LARGE_NEW_CODE_LINES) {
    add(POINTS_FOR_LARGE_NEW_CODE, "It's a large piece of new code")
  }
  const sensitive = inFile.find((finding) => finding.category === RiskCategory.SensitivePath && finding.location?.line === null)
  if (sensitive !== undefined) add(POINTS_FOR_SENSITIVE_FILE, `It's in a sensitive area: ${sensitive.title.toLowerCase()}`)
  return { points, reasons }
}

function pointsForFindings(findings: readonly Risk[]): number {
  const worst = Math.max(0, ...findings.map(pointsForFinding))
  return worst + Math.min(MAX_EXTRA_FINDINGS_COUNTED, Math.max(0, findings.length - 1)) * POINTS_PER_EXTRA_FINDING
}

// Messy code deserves a look, but must never outrank something that could be a security problem.
function pointsForFinding(finding: Risk): number {
  if (finding.category === RiskCategory.CodeQuality) return POINTS_FOR_CODE_QUALITY
  return POINTS_FOR_FINDING[finding.severity] + (finding.category === RiskCategory.BreakingChange ? POINTS_FOR_BREAKING_CHANGE : 0)
}

function reasonsFromFindings(findings: readonly Risk[]): string[] {
  const dependencies = findings.filter((finding) => finding.category === RiskCategory.Dependency).length
  return [
    ...(dependencies > 1 ? [`It adds ${dependencies} new dependencies`] : []),
    ...new Set(findings.filter((finding) => dependencies <= 1 || finding.category !== RiskCategory.Dependency).map(reasonFromFinding)),
  ]
}

// A finding about a whole file has no line to show, so its explanation is the reason itself.
function reasonFromFinding(finding: Risk): string {
  const firstSentence = FIRST_SENTENCE.exec(finding.detail)?.[0]
  if (firstSentence === undefined) return `Flagged: ${finding.title}`
  // A breaking change's reason is what could break, which the first sentence says wherever it points.
  return finding.location?.line === null || finding.category === RiskCategory.BreakingChange ? `${finding.title}: ${firstSentence}` : `Flagged: ${finding.title}`
}

function testFilesMentioning(unit: ChangedUnit, file: ChangedFile, testFiles: readonly ChangedFile[]): string[] {
  const fromReferences = unit.impact?.status === UnitImpactStatus.Traced ? unit.impact.references.map((reference) => reference.path).filter(isTestPath) : []
  const name = unit.name
  const fromTestChanges = name.length < MIN_NAME_LENGTH_TO_MATCH_IN_TESTS ? [] : testFiles.filter((testFile) => addedText(testFile).includes(name)).map((testFile) => testFile.diff.path)
  // Rust and others keep tests in the same file as the code.
  const inlineTests = changedUnitsOf(file).some((other) => TEST_UNIT.test(other.qualifiedName) && "after" in other.change && other.change.after.text.includes(name))
  return [...new Set([...fromReferences, ...fromTestChanges, ...(inlineTests ? [file.diff.path] : [])])]
}

function addedText(file: ChangedFile): string {
  if (file.diff.content.kind === FileContentKind.Binary) return ""
  return file.diff.content.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === DiffLineKind.Added).map((line) => line.content)).join("\n")
}

function summarizeLowerPriority(files: readonly ChangedFile[], stops: readonly ReviewStop[], testFiles: number): LowerPriority {
  const onPath = new Set(stops.flatMap((stop) => (stop.unit === null ? [] : [stop.unit])))
  const filesOnPath = new Set(stops.filter((stop) => stop.unit === null).map((stop) => stop.file.diff.path))
  const summary = { newCode: 0, otherCode: 0, quiet: 0, testFiles, otherFiles: 0 }
  for (const file of files) {
    if (isTestPath(file.diff.path) && file.noise === null) continue
    const units = changedUnitsOf(file).filter((unit) => !onPath.has(unit) && !TEST_UNIT.test(unit.qualifiedName))
    if (changedUnitsOf(file).length === 0 && !filesOnPath.has(file.diff.path)) summary.otherFiles++
    for (const unit of units) {
      if (!isBehaviourChange(unit.change)) summary.quiet++
      else if (unit.change.kind === UnitChangeKind.Added) summary.newCode++
      else summary.otherCode++
    }
  }
  return summary
}

/** One line per decision the reviewer has to make, so seven new dependencies read as one. */
function groupChecks(findings: readonly Risk[], stops: readonly ReviewStop[]): ReviewCheck[] {
  const groups = new Map<string, Risk[]>()
  for (const finding of findings) {
    if (CATEGORIES_NOT_IN_CHECKS.has(finding.category)) continue
    const key = finding.category === RiskCategory.Dependency ? `${finding.category}\0${finding.location?.path ?? ""}` : `${finding.category}\0${finding.title}`
    groups.set(key, [...(groups.get(key) ?? []), finding])
  }
  return [...groups.values()].flatMap((group) => {
    const first = group.at(0)
    return first === undefined ? [] : [{ severity: first.severity, message: checkMessage(first, group.length), stopIndex: stopIndexOf(group, stops) }]
  }).sort((a, b) => POINTS_FOR_FINDING[b.severity] - POINTS_FOR_FINDING[a.severity])
}

function stopIndexOf(group: readonly Risk[], stops: readonly ReviewStop[]): number | undefined {
  const index = stops.findIndex((stop) => group.some((finding) => stop.findings.includes(finding) || (finding.location?.line === null && finding.location.path === stop.file.diff.path)))
  return index === -1 ? undefined : index
}

function checkMessage(finding: Risk, count: number): string {
  const where = finding.location === null ? "" : ` in ${finding.location.path}`
  const times = count > 1 ? ` (${count} places)` : ""
  switch (finding.category) {
    case RiskCategory.Secret:
      return `Possible secret${where}${times}. If it's real, revoke it.`
    case RiskCategory.DangerousApi:
      return `${finding.title}${where}${times}. Check that users can't control the input.`
    case RiskCategory.SensitivePath:
      return `${finding.title} changed${count > 1 ? ` in ${count} files` : where}. Check this is intended.`
    case RiskCategory.Dependency:
      return count > 1 ? `${count} new dependencies${where}. Check that you trust them.` : `${finding.title}${where}. Check that you trust it.`
    case RiskCategory.Vulnerability:
      return `${finding.title}${where}. Upgrade before merging if you can.`
    case RiskCategory.CodeScan:
      return `Code scan: ${finding.title}${where}${times}. Check whether it applies here.`
    case RiskCategory.Tests:
      return `${finding.title}. Ask whether this needs tests.`
    case RiskCategory.License:
      return `${finding.title}${where}. Check it's acceptable before merging.`
    case RiskCategory.BrokenReference:
      return `${finding.title}${where}. Check that nothing still depends on it.`
    case RiskCategory.BreakingChange:
      return `${finding.title}${times}${where}. This may break callers or a deployment, so check who depends on it.`
    case RiskCategory.Size:
    case RiskCategory.CodeQuality:
      return finding.title
  }
}

function places(count: number): string {
  return count === 1 ? "1 place" : `${count} places`
}

function isEditOfExistingCode(change: UnitChange): boolean {
  return change.kind === UnitChangeKind.Modified || (change.kind === UnitChangeKind.MovedIn && change.edited)
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/** The label for how a change affects files, shown beside a stop. */
export function changeSummary(stop: ReviewStop): string {
  if (stop.unit === null) return stop.file.diff.status === FileChangeStatus.Added ? "New file" : "Changed file"
  switch (stop.unit.change.kind) {
    case UnitChangeKind.Added:
      return "New"
    case UnitChangeKind.Removed:
      return "Removed"
    default:
      return "Changed"
  }
}

export const GuideRouteKind = { Brief: "brief", Stop: "stop", Finish: "finish" } as const

export type GuideRoute = { readonly kind: typeof GuideRouteKind.Brief } | { readonly kind: typeof GuideRouteKind.Stop; readonly index: number } | { readonly kind: typeof GuideRouteKind.Finish }

const REVIEW_HASH = "#review"
const FINISH_HASH = "#review/finish"
const STOP_HASH = /^#review\/(\d+)$/

/** The guided view named by the URL, or undefined for the full lists. */
export function guideRouteFromHash(hash: string): GuideRoute | undefined {
  if (hash === "" || hash === REVIEW_HASH) return { kind: GuideRouteKind.Brief }
  if (hash === FINISH_HASH) return { kind: GuideRouteKind.Finish }
  const stop = STOP_HASH.exec(hash)?.[1]
  return stop === undefined ? undefined : { kind: GuideRouteKind.Stop, index: Number(stop) }
}

export function hashForStop(index: number): string {
  return `${REVIEW_HASH}/${index}`
}

export { FINISH_HASH, REVIEW_HASH }
