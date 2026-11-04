import { changedUnitsOf, DiffLineKind, FileChangeStatus, FileContentKind, isBehaviourChange, UnitChangeKind, unitSnapshotSchema } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, ReviewComment, ReviewModel, UnitSnapshot } from "@walkdiff/review-model"
import { buildReviewPlan, isTestPath, isTestUnit, stopFor } from "./reviewPlan.ts"
import type { ReviewPlan, ReviewStop } from "./reviewPlan.ts"
import { describeRange, reviewCommentFromLines } from "./lineComments.ts"
import type { LineComment } from "./lineComments.ts"

/**
 * The version of a change the reviewer marked. Keeping its text is what lets a later push show
 * only what changed since, without fetching the older commit.
 */
export interface ReviewedVersion {
  readonly fingerprint: string
  /** Null for a file shown as a line diff, which has no single version to compare with. */
  readonly snapshot: UnitSnapshot | null
}

/**
 * What the reviewer has done so far. Items are identified by what they are rather than by their
 * place on the path, so the path and "All changes" share one record, and a change in the ranking
 * can't move a tick onto a different function.
 */
export interface ReviewState {
  readonly reviewed: ReadonlyMap<string, ReviewedVersion>
  readonly comments: ReadonlyMap<string, string>
}

export const EMPTY_REVIEW_STATE: ReviewState = { reviewed: new Map(), comments: new Map() }

export const ItemKind = { NewCode: "newCode", ChangedCode: "changedCode", Test: "test", File: "file" } as const
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind]

/** Something a reviewer can mark as reviewed. */
export interface ReviewItem {
  readonly id: string
  readonly kind: ItemKind
  readonly path: string
  readonly label: string
  /** Changes when the item's content does, so a tick can't outlive what was reviewed. */
  readonly fingerprint: string
  readonly snapshot: UnitSnapshot | null
  readonly file: ChangedFile
  readonly unit: ChangedUnit | null
}

export interface Progress {
  readonly reviewed: number
  readonly total: number
}

export function unitItemId(file: ChangedFile, unit: ChangedUnit): string {
  // Overloads and cfg variants can repeat a name in one file, so its position separates them.
  const sameName = changedUnitsOf(file).filter((other) => other.kind === unit.kind && other.qualifiedName === unit.qualifiedName)
  return `${file.diff.path}\0${unit.kind}\0${unit.qualifiedName}\0${sameName.indexOf(unit)}`
}

function fileItemId(file: ChangedFile): string {
  return `${file.diff.path}\0file`
}

/** The items a file adds to the overall review. Skippable files and formatting edits add none. */
export function itemsOfFile(file: ChangedFile): ReviewItem[] {
  if (file.noise !== null) return []
  const units = changedUnitsOf(file)
  if (units.length === 0) return [fileItem(file)]
  return units.filter((unit) => isBehaviourChange(unit.change)).map((unit) => unitItem(file, unit))
}

export function unitItem(file: ChangedFile, unit: ChangedUnit): ReviewItem {
  const snapshot = currentSnapshot(unit)
  return { id: unitItemId(file, unit), kind: kindOfUnit(file, unit), path: file.diff.path, label: unit.qualifiedName, fingerprint: fingerprintOf(snapshot.text), snapshot: unit.change.kind === UnitChangeKind.Removed ? null : snapshot, file, unit }
}

function fileItem(file: ChangedFile): ReviewItem {
  return { id: fileItemId(file), kind: isTestPath(file.diff.path) ? ItemKind.Test : ItemKind.File, path: file.diff.path, label: file.diff.path, fingerprint: fingerprintOf(changedLinesOf(file)), snapshot: null, file, unit: null }
}

function currentSnapshot(unit: ChangedUnit): UnitSnapshot {
  return "after" in unit.change ? unit.change.after : unit.change.before
}

// Without line numbers, so code that only moved down the file keeps its tick.
function changedLinesOf(file: ChangedFile): string {
  if (file.diff.content.kind === FileContentKind.Binary) return `${file.diff.status}\0binary`
  return file.diff.content.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== DiffLineKind.Context).map((line) => `${line.kind}\0${line.content}`)).join("\n")
}

const FINGERPRINT_SEED_A = 0xdeadbeef
const FINGERPRINT_SEED_B = 0x41c6ce57
const FINGERPRINT_MIX_A = 2654435761
const FINGERPRINT_MIX_B = 1597334677
const FINGERPRINT_FINAL_A = 2246822507
const FINGERPRINT_FINAL_B = 3266489909
const FINGERPRINT_RADIX = 36

/**
 * The cyrb53 string hash (public domain, https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js).
 * It only tells a reviewer's own versions apart in their own browser, so it needn't resist
 * attack. It is used instead of Web Crypto because that is asynchronous and unavailable on
 * pages opened from disk.
 */
function fingerprintOf(text: string): string {
  let a = FINGERPRINT_SEED_A
  let b = FINGERPRINT_SEED_B
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, FINGERPRINT_MIX_A)
    b = Math.imul(b ^ code, FINGERPRINT_MIX_B)
  }
  a = Math.imul(a ^ (a >>> 16), FINGERPRINT_FINAL_A) ^ Math.imul(b ^ (b >>> 13), FINGERPRINT_FINAL_B)
  b = Math.imul(b ^ (b >>> 16), FINGERPRINT_FINAL_A) ^ Math.imul(a ^ (a >>> 13), FINGERPRINT_FINAL_B)
  return `${(b >>> 0).toString(FINGERPRINT_RADIX)}.${(a >>> 0).toString(FINGERPRINT_RADIX)}`
}

function kindOfUnit(file: ChangedFile, unit: ChangedUnit): ItemKind {
  if (isTestPath(file.diff.path) || isTestUnit(unit)) return ItemKind.Test
  return unit.change.kind === UnitChangeKind.Added ? ItemKind.NewCode : ItemKind.ChangedCode
}

/** The items a stop stands for: its function, or everything in a file shown whole. */
export function stopItems(stop: ReviewStop): readonly ReviewItem[] {
  if (stop.unit !== null) return [unitItem(stop.file, stop.unit)]
  const items = itemsOfFile(stop.file)
  return items.length > 0 ? items : [fileItem(stop.file)]
}

export function isItemReviewed(item: ReviewItem, state: ReviewState): boolean {
  return state.reviewed.get(item.id)?.fingerprint === item.fingerprint
}

export function isReviewed(items: readonly ReviewItem[], state: ReviewState): boolean {
  return items.length > 0 && items.every((item) => isItemReviewed(item, state))
}

export function fileProgress(file: ChangedFile, state: ReviewState): Progress {
  const items = itemsOfFile(file)
  return { reviewed: items.filter((item) => isItemReviewed(item, state)).length, total: items.length }
}

export function overallProgress(files: readonly ChangedFile[], state: ReviewState): Progress {
  return files.map((file) => fileProgress(file, state)).reduce((sum, progress) => ({ reviewed: sum.reviewed + progress.reviewed, total: sum.total + progress.total }), { reviewed: 0, total: 0 })
}

export function pathProgress(plan: ReviewPlan, state: ReviewState): Progress {
  return { reviewed: plan.stops.filter((stop) => isReviewed(stopItems(stop), state)).length, total: plan.stops.length }
}

/** Where to pick up: the first stop not yet reviewed, or undefined when the path is done. */
export function nextUnreviewedStop(plan: ReviewPlan, state: ReviewState): number | undefined {
  const index = plan.stops.findIndex((stop) => !isReviewed(stopItems(stop), state))
  return index === -1 ? undefined : index
}

/** Things the reviewer marked whose content has changed since, as after a new push. */
export function changedSinceReview(files: readonly ChangedFile[], state: ReviewState): ReviewItem[] {
  return files.flatMap(itemsOfFile).filter((item) => state.reviewed.has(item.id) && !isItemReviewed(item, state))
}

const REASON_CHANGED_SINCE_REVIEW = "You reviewed an earlier version, and it has changed"

/**
 * Puts what changed since the last review first, including anything reviewed outside the path,
 * since those are what a returning reviewer came back for. Called with the set as it stood when
 * the page opened: reviewing a stop must not move the stops around while someone works.
 */
export function withChangedFirst(plan: ReviewPlan, changed: readonly ReviewItem[], makeStop: (item: ReviewItem) => ReviewStop): ReviewPlan {
  if (changed.length === 0) return plan
  const changedIds = new Set(changed.map((item) => item.id))
  const isChanged = (stop: ReviewStop): boolean => stopItems(stop).some((item) => changedIds.has(item.id))
  const onPath = new Set(plan.stops.flatMap((stop) => stopItems(stop).map((item) => item.id)))
  const added = changed.filter((item) => !onPath.has(item.id)).map(makeStop)
  const moved = plan.stops.filter(isChanged)
  const flagged = [...moved, ...added].map((stop) => ({ ...stop, reasons: [REASON_CHANGED_SINCE_REVIEW, ...stop.reasons] }))
  return { ...plan, stops: [...flagged, ...plan.stops.filter((stop) => !isChanged(stop))], lowerPriorityTotal: Math.max(0, plan.lowerPriorityTotal - added.length) }
}

/** The path for this reviewer, given what had changed when the page opened. */
export function reviewPlanFor(review: ReviewModel, changed: readonly ReviewItem[]): ReviewPlan {
  return withChangedFirst(buildReviewPlan(review), changed, (item) => stopFor(review, item.file, item.unit))
}

export type RemainingCounts = Readonly<Record<ItemKind, number>>

/** What is still unreviewed and not on the path, so the finish screen reflects all marking. */
export function remainingOffPath(files: readonly ChangedFile[], plan: ReviewPlan, state: ReviewState): RemainingCounts {
  const onPath = new Set(plan.stops.flatMap((stop) => stopItems(stop).map((item) => item.id)))
  const counts: Record<ItemKind, number> = { [ItemKind.NewCode]: 0, [ItemKind.ChangedCode]: 0, [ItemKind.Test]: 0, [ItemKind.File]: 0 }
  for (const item of files.flatMap(itemsOfFile)) {
    if (!onPath.has(item.id) && !isItemReviewed(item, state)) counts[item.kind]++
  }
  return counts
}

export interface ItemComment {
  readonly item: ReviewItem
  readonly text: string
}

export function commentsOnItems(files: readonly ChangedFile[], state: ReviewState): ItemComment[] {
  return files.flatMap(itemsOfFile).flatMap((item) => {
    const text = state.comments.get(item.id)?.trim()
    return text === undefined || text === "" ? [] : [{ item, text }]
  })
}

/**
 * Comments in the form a host takes. A comment sits on the item's first added line, because a
 * host only accepts comments on lines in the diff. With no such line, as for a removed function,
 * it goes in the review's text instead.
 */
export function reviewCommentsFrom(comments: readonly ItemComment[], lineComments: readonly LineComment[] = [], files: readonly ChangedFile[] = []): ReviewComment[] {
  return [...comments.map(({ item, text }) => ({ path: item.path, previousPath: previousPathOf(item.file), line: firstAddedLine(item), label: item.label, range: null, body: text })), ...lineComments.map((comment) => reviewCommentFromLines(comment, files))]
}

function previousPathOf(file: ChangedFile): string {
  return file.diff.status === FileChangeStatus.Renamed || file.diff.status === FileChangeStatus.Copied ? file.diff.previousPath : file.diff.path
}

function firstAddedLine(item: ReviewItem): number | null {
  const { content } = item.file.diff
  if (content.kind === FileContentKind.Binary) return null
  const added = content.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line.kind === DiffLineKind.Added ? [line.newLine] : [])))
  const snapshot = item.snapshot
  const inItem = snapshot === null ? added : added.filter((line) => line >= snapshot.startLine && line <= snapshot.endLine)
  return inItem.at(0) ?? null
}

/** Ready to paste into the PR, for reports opened outside the app. */
export function commentsAsMarkdown(comments: readonly ItemComment[], lineComments: readonly LineComment[] = []): string {
  const onLines = lineComments.map(({ path, range, text }) => `**\`${path}\`** ${describeRange(range)}\n\n${text}`)
  return [...comments.map(({ item, text }) => (item.label === item.path ? `**\`${item.path}\`**\n\n${text}` : `**\`${item.label}\`** in \`${item.path}\`\n\n${text}`)), ...onLines].join("\n\n---\n\n")
}

/** Reads saved state defensively: browser storage can hold anything, or an older format. */
export function parseSavedState(text: string | null): ReviewState {
  if (text === null) return EMPTY_REVIEW_STATE
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return EMPTY_REVIEW_STATE
    const reviewed = "reviewed" in parsed && Array.isArray(parsed.reviewed) ? parsed.reviewed.flatMap(reviewedEntry) : []
    const comments = "comments" in parsed && Array.isArray(parsed.comments) ? parsed.comments.flatMap(commentEntry) : []
    return { reviewed: new Map(reviewed), comments: new Map(comments) }
  } catch {
    return EMPTY_REVIEW_STATE
  }
}

function reviewedEntry(entry: unknown): [string, ReviewedVersion][] {
  if (!Array.isArray(entry)) return []
  const [id, fingerprint, snapshot]: unknown[] = entry
  if (typeof id !== "string" || typeof fingerprint !== "string") return []
  const parsed = unitSnapshotSchema.nullable().safeParse(snapshot ?? null)
  return [[id, { fingerprint, snapshot: parsed.success ? parsed.data : null }]]
}

function commentEntry(entry: unknown): [string, string][] {
  if (!Array.isArray(entry)) return []
  const [id, text]: unknown[] = entry
  return typeof id === "string" && typeof text === "string" ? [[id, text]] : []
}

export function serializeState(state: ReviewState): string {
  return JSON.stringify({ reviewed: [...state.reviewed].map(([id, version]) => [id, version.fingerprint, version.snapshot]), comments: [...state.comments] })
}

export function withReviewed(state: ReviewState, items: readonly ReviewItem[], reviewed: boolean): ReviewState {
  const next = new Map(state.reviewed)
  for (const item of items) {
    if (reviewed) next.set(item.id, { fingerprint: item.fingerprint, snapshot: item.snapshot })
    else next.delete(item.id)
  }
  return { ...state, reviewed: next }
}

export function withComment(state: ReviewState, id: string, text: string): ReviewState {
  const next = new Map(state.comments)
  if (text === "") next.delete(id)
  else next.set(id, text)
  return { ...state, comments: next }
}
