import { DatabaseSync } from "node:sqlite"
import { appSettingsSchema, commitShaSchema, DEFAULT_APP_SETTINGS, GitHostKind, pullRequestStackSchema, ReviewStatus, reviewSummarySchema, testCoverageSchema } from "@walkdiff/review-model"
import type { AppSettings, CommitSha, PullRequestStack, ReviewSummary } from "@walkdiff/review-model"
import { z } from "zod"
import type { AttachedCoverage } from "../reviewCommand.ts"

/** Each entry moves the database one version forward; `PRAGMA user_version` records how far. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE reviews (
     id INTEGER PRIMARY KEY,
     url TEXT NOT NULL UNIQUE,
     host TEXT NOT NULL,
     display_name TEXT NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     report_dir TEXT,
     ai INTEGER NOT NULL,
     title TEXT,
     author TEXT,
     security_level TEXT,
     units_to_review INTEGER,
     untouched_references INTEGER,
     findings INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`,
  `ALTER TABLE reviews ADD COLUMN coverage_source TEXT`,
  `ALTER TABLE reviews ADD COLUMN attached_coverage TEXT`,
  `CREATE TABLE stacks (id INTEGER PRIMARY KEY, trunk TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `ALTER TABLE reviews ADD COLUMN stack_id INTEGER REFERENCES stacks (id)`,
  `ALTER TABLE reviews ADD COLUMN stack_position INTEGER`,
  // The last stack found from this review, kept so its offer survives a restart.
  `ALTER TABLE reviews ADD COLUMN detected_stack TEXT`,
  `ALTER TABLE reviews ADD COLUMN dismissed_stack_members TEXT`,
  // What the report was made from, to tell when the PR has moved on since.
  `ALTER TABLE reviews ADD COLUMN head_sha TEXT`,
  `ALTER TABLE reviews ADD COLUMN base_ref TEXT`,
]

const attachedCoverageSchema = z.object({ headSha: z.string(), coverage: testCoverageSchema })

const dismissedSchema = z.array(z.number().int().positive())
const stackRowSchema = z.object({ id: z.number(), trunk: z.string() })
const countSchema = z.object({ id: z.number(), members: z.number() })

const settingsRowSchema = z.object({ json: z.string() })

const INTERRUPTED_ERROR = "The app stopped during this analysis. Refresh to run it again."

const reviewRowSchema = z.object({
  id: z.number(),
  url: z.string(),
  host: z.enum(GitHostKind),
  display_name: z.string(),
  status: z.enum(ReviewStatus),
  error: z.string().nullable(),
  report_dir: z.string().nullable(),
  ai: z.number(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  security_level: z.string().nullable(),
  units_to_review: z.number().nullable(),
  untouched_references: z.number().nullable(),
  findings: z.number().nullable(),
  coverage_source: z.string().nullable(),
  attached_coverage: z.string().nullable(),
  stack_id: z.number().nullable(),
  stack_position: z.number().nullable(),
  detected_stack: z.string().nullable(),
  dismissed_stack_members: z.string().nullable(),
  head_sha: z.string().nullable(),
  base_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export interface NewReview {
  readonly url: string
  readonly host: GitHostKind
  readonly displayName: string
  readonly ai: boolean
}

export interface CompletedAnalysis {
  readonly reportDir: string
  readonly title: string
  readonly author: string
  readonly securityLevel: string
  readonly unitsToReview: number
  readonly untouchedReferences: number
  readonly findings: number
  readonly coverageSource: string | null
  readonly head: AnalyzedHead
}

/** The commit a report was made from, and the branch it was compared with. */
export interface AnalyzedHead {
  readonly headSha: CommitSha
  readonly baseRef: string
}

/** The last stack found from a review, and the members the reviewer turned down. */
export interface Detection {
  readonly stack: PullRequestStack
  readonly dismissed: ReadonlySet<number>
}

export interface GroupedStack {
  readonly id: number
  readonly trunk: string
}

/**
 * The local app's list of reviews, in SQLite so it survives restarts. It holds what the
 * host has no place for; comments and approvals stay on the host.
 */
export class ReviewStore {
  readonly #db: DatabaseSync
  readonly #now: () => Date

  constructor(databasePath: string, now: () => Date) {
    this.#db = new DatabaseSync(databasePath)
    this.#now = now
    this.#migrate()
  }

  close(): void {
    this.#db.close()
  }

  list(): ReviewSummary[] {
    return this.#db.prepare("SELECT * FROM reviews ORDER BY created_at DESC, id DESC").all().map(toSummary)
  }

  get(id: number): ReviewSummary | undefined {
    const row = this.#row(id)
    return row === undefined ? undefined : toSummary(row)
  }

  getByUrl(url: string): ReviewSummary | undefined {
    const row: unknown = this.#db.prepare("SELECT * FROM reviews WHERE url = ?").get(url)
    return row === undefined ? undefined : toSummary(row)
  }

  reportDirOf(id: number): string | undefined {
    return this.#parsedRow(id)?.report_dir ?? undefined
  }

  add(review: NewReview): ReviewSummary {
    const now = this.#timestamp()
    const { lastInsertRowid } = this.#db
      .prepare("INSERT INTO reviews (url, host, display_name, status, ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(review.url, review.host, review.displayName, ReviewStatus.Queued, review.ai ? 1 : 0, now, now)
    const added = this.get(Number(lastInsertRowid))
    if (added === undefined) throw new Error("The review just added could not be read back")
    return added
  }

  /** Sets a review's status, clearing any earlier error. */
  setAi(id: number, ai: boolean): void {
    this.#db.prepare("UPDATE reviews SET ai = ?, updated_at = ? WHERE id = ?").run(ai ? 1 : 0, this.#timestamp(), id)
  }

  setStatus(id: number, status: ReviewStatus): void {
    this.#db.prepare("UPDATE reviews SET status = ?, error = NULL, updated_at = ? WHERE id = ?").run(status, this.#timestamp(), id)
  }

  markReady(id: number, analysis: CompletedAnalysis): void {
    this.#db
      .prepare(
        `UPDATE reviews SET status = ?, error = NULL, report_dir = ?, title = ?, author = ?, security_level = ?,
           units_to_review = ?, untouched_references = ?, findings = ?, coverage_source = ?, head_sha = ?, base_ref = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        ReviewStatus.Ready,
        analysis.reportDir,
        analysis.title,
        analysis.author,
        analysis.securityLevel,
        analysis.unitsToReview,
        analysis.untouchedReferences,
        analysis.findings,
        analysis.coverageSource,
        analysis.head.headSha,
        analysis.head.baseRef,
        this.#timestamp(),
        id,
      )
  }

  /** Undefined until an analysis succeeds. */
  analyzedHeadOf(id: number): AnalyzedHead | undefined {
    const row = this.#parsedRow(id)
    const headSha = row?.head_sha ?? null
    const baseRef = row?.base_ref ?? null
    return headSha === null || baseRef === null ? undefined : { headSha: commitShaSchema.parse(headSha), baseRef }
  }

  /** Records what the last detection found; undefined clears it, for a PR that now stands alone. */
  saveDetection(id: number, stack: PullRequestStack | undefined): void {
    this.#db.prepare("UPDATE reviews SET detected_stack = ? WHERE id = ?").run(stack === undefined ? null : JSON.stringify(stack), id)
  }

  /** Every review's last detection, by review id. */
  detections(): ReadonlyMap<number, Detection> {
    const rows = this.#db.prepare("SELECT * FROM reviews WHERE detected_stack IS NOT NULL").all().map((row) => reviewRowSchema.parse(row))
    return new Map(rows.flatMap((row) => {
      const detection = detectionOf(row)
      return detection === undefined ? [] : [[row.id, detection] as const]
    }))
  }

  detectionOf(id: number): Detection | undefined {
    const row = this.#parsedRow(id)
    return row === undefined ? undefined : detectionOf(row)
  }

  /** Adds to the members this review won't offer again. */
  dismiss(id: number, numbers: Iterable<number>): void {
    const dismissed = new Set([...dismissedOf(this.#parsedRow(id)), ...numbers])
    this.#db.prepare("UPDATE reviews SET dismissed_stack_members = ? WHERE id = ?").run(JSON.stringify([...dismissed]), id)
  }

  createStack(trunk: string): number {
    const { lastInsertRowid } = this.#db.prepare("INSERT INTO stacks (trunk, created_at) VALUES (?, ?)").run(trunk, this.#timestamp())
    return Number(lastInsertRowid)
  }

  stack(id: number): GroupedStack | undefined {
    const row = this.#db.prepare("SELECT id, trunk FROM stacks WHERE id = ?").get(id)
    return row === undefined ? undefined : stackRowSchema.parse(row)
  }

  /** Bottom first. */
  stackMembers(id: number): ReviewSummary[] {
    return this.#db.prepare("SELECT * FROM reviews WHERE stack_id = ? ORDER BY stack_position, id").all(id).map(toSummary)
  }

  /** Makes the reviews with these URLs the stack's members, bottom first, from wherever they were before. */
  regroup(stackId: number, trunk: string, urls: readonly string[]): void {
    this.#inTransaction(() => {
      this.#db.prepare("UPDATE stacks SET trunk = ? WHERE id = ?").run(trunk, stackId)
      const place = this.#db.prepare("UPDATE reviews SET stack_id = ?, stack_position = ?, updated_at = ? WHERE url = ?")
      urls.forEach((url, index) => place.run(stackId, index + 1, this.#timestamp(), url))
      this.#dropLoneStacks()
    })
  }

  /** Keeps the reviews, ungrouped. */
  ungroup(stackId: number): void {
    this.#inTransaction(() => {
      this.#db.prepare("UPDATE reviews SET stack_id = NULL, stack_position = NULL, updated_at = ? WHERE stack_id = ?").run(this.#timestamp(), stackId)
      this.#db.prepare("DELETE FROM stacks WHERE id = ?").run(stackId)
    })
  }

  /** Undefined when nothing is attached. */
  attachedCoverageOf(id: number): AttachedCoverage | undefined {
    const json = this.#parsedRow(id)?.attached_coverage ?? null
    return json === null ? undefined : attachedCoverageSchema.parse(JSON.parse(json))
  }

  saveAttachedCoverage(id: number, attached: AttachedCoverage): void {
    this.#db
      .prepare("UPDATE reviews SET attached_coverage = ?, coverage_source = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(attached), attached.coverage.source, this.#timestamp(), id)
  }

  markFailed(id: number, error: string): void {
    this.#db.prepare("UPDATE reviews SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(ReviewStatus.Failed, error, this.#timestamp(), id)
  }

  remove(id: number): void {
    this.#inTransaction(() => {
      this.#db.prepare("DELETE FROM reviews WHERE id = ?").run(id)
      this.#dropLoneStacks()
    })
  }

  /** Analyses run in memory, so any still unfinished at startup were cut short by a restart. */
  markInterrupted(): void {
    this.#db
      .prepare("UPDATE reviews SET status = ?, error = ?, updated_at = ? WHERE status IN (?, ?)")
      .run(ReviewStatus.Failed, INTERRUPTED_ERROR, this.#timestamp(), ReviewStatus.Queued, ReviewStatus.Analyzing)
  }

  /** Falls back to the defaults if saved settings can't be read, as after a downgrade. */
  getSettings(): AppSettings {
    const row = settingsRowSchema.safeParse(this.#db.prepare("SELECT json FROM settings WHERE id = 1").get())
    if (!row.success) return DEFAULT_APP_SETTINGS
    try {
      const parsed = appSettingsSchema.safeParse(JSON.parse(row.data.json))
      return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS
    } catch {
      return DEFAULT_APP_SETTINGS
    }
  }

  saveSettings(settings: AppSettings): void {
    this.#db.prepare("INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json").run(JSON.stringify(settings))
  }

  #migrate(): void {
    const version = z.object({ user_version: z.number() }).parse(this.#db.prepare("PRAGMA user_version").get()).user_version
    MIGRATIONS.slice(version).forEach((migration, index) => {
      this.#db.exec(migration)
      // PRAGMA takes no bound parameters; the value is a number computed here.
      this.#db.exec(`PRAGMA user_version = ${version + index + 1}`)
    })
  }

  /** A stack of one is no longer a stack, as after its other members were removed or moved. */
  #dropLoneStacks(): void {
    const counts = this.#db.prepare("SELECT stacks.id AS id, COUNT(reviews.id) AS members FROM stacks LEFT JOIN reviews ON reviews.stack_id = stacks.id GROUP BY stacks.id").all()
    for (const { id, members } of counts.map((row) => countSchema.parse(row))) {
      if (members < 2) this.ungroup(id)
    }
  }

  /** Runs the statements together, so a failure part-way changes nothing. Nested calls join the outer one. */
  #inTransaction(act: () => void): void {
    if (this.#db.isTransaction) {
      act()
      return
    }
    this.#db.exec("BEGIN")
    try {
      act()
      this.#db.exec("COMMIT")
    } catch (error: unknown) {
      this.#db.exec("ROLLBACK")
      throw error
    }
  }

  #row(id: number): unknown {
    return this.#db.prepare("SELECT * FROM reviews WHERE id = ?").get(id)
  }

  #parsedRow(id: number): ReviewRow | undefined {
    const row = this.#row(id)
    return row === undefined ? undefined : reviewRowSchema.parse(row)
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }
}

function toSummary(row: unknown): ReviewSummary {
  const parsed = reviewRowSchema.parse(row)
  return reviewSummarySchema.parse({
    id: parsed.id,
    url: parsed.url,
    host: parsed.host,
    displayName: parsed.display_name,
    status: parsed.status,
    error: parsed.error,
    hasReport: parsed.report_dir !== null,
    ai: parsed.ai === 1,
    title: parsed.title,
    author: parsed.author,
    securityLevel: parsed.security_level,
    unitsToReview: parsed.units_to_review,
    untouchedReferences: parsed.untouched_references,
    findings: parsed.findings,
    coverageSource: parsed.coverage_source,
    stack: parsed.stack_id === null || parsed.stack_position === null ? null : { id: parsed.stack_id, position: parsed.stack_position },
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  })
}

type ReviewRow = z.infer<typeof reviewRowSchema>

/** Undefined when there is none, or when it was saved by a version that described stacks differently. */
function detectionOf(row: ReviewRow): Detection | undefined {
  if (row.detected_stack === null) return undefined
  const stack = pullRequestStackSchema.safeParse(JSON.parse(row.detected_stack))
  return stack.success ? { stack: stack.data, dismissed: dismissedOf(row) } : undefined
}

function dismissedOf(row: ReviewRow | undefined): ReadonlySet<number> {
  const json = row?.dismissed_stack_members ?? null
  return new Set(json === null ? [] : dismissedSchema.parse(JSON.parse(json)))
}
