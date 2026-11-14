import { codeSpan, DiffLineKind, FileChangeStatus, FileContentKind, isTestPath, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { FileDiff, Risk } from "@walkdiff/review-model"
import { findingAt, isThirdParty } from "../scannedFile.ts"
import type { RuleDescription, ScannedFile } from "../scannedFile.ts"
import { describeMentions, isSpecificName } from "./codeMentions.ts"
import type { CodeMention } from "./codeMentions.ts"
import { isMigrationPath } from "../migrationFiles.ts"

export const SchemaChangeKind = {
  DropTable: "dropTable",
  DropColumn: "dropColumn",
  RenameTable: "renameTable",
  RenameColumn: "renameColumn",
  ChangeType: "changeType",
} as const
export type SchemaChangeKind = (typeof SchemaChangeKind)[keyof typeof SchemaChangeKind]

export interface SchemaChange {
  readonly kind: SchemaChangeKind
  /** The table or column before the change. */
  readonly name: string
  readonly path: string
  readonly line: number
  readonly statement: string
}

// The file holds only the way back: sqlx and golang-migrate's `.down.sql`, Flyway's `U1__x.sql`.
const DOWN_FILE = /\.down\.sql$|(^|\/)U\d[^/]*\.sql$/i
const DOWN_SECTION = /\bdef\s+down(?:grade)?\b|\bdown\s*[(:=]|\bexports\.down\b|\+goose\s+Down|\+migrate\s+Down|migrate:down/i
const UP_SECTION = /\bdef\s+(?:up(?:grade)?|change)\b|\bup\s*[(:=]|\bexports\.up\b|\+goose\s+Up|\+migrate\s+Up|migrate:up/i
const COMMENT_LINE = /^\s*(?:--|#|\/\/|\/\*|\*)/
// Staging tables built and thrown away inside a migration, or copies kept as a safety net.
const THROWAWAY_NAME = /^(?:tmp|temp|new|old|backup|bak)_|_(?:tmp|temp|new|old|backup|bak)$|^__/i

const IDENTIFIER = String.raw`["'\`\[]?(?:\w+["'\`\]]?\.["'\`\[]?)?(\w+)["'\`\]]?`

interface SqlPattern {
  readonly kind: SchemaChangeKind
  readonly pattern: RegExp
}

const SQL_PATTERNS: readonly SqlPattern[] = [
  { kind: SchemaChangeKind.DropTable, pattern: new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}`, "i") },
  { kind: SchemaChangeKind.DropColumn, pattern: new RegExp(String.raw`\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}`, "i") },
  { kind: SchemaChangeKind.RenameColumn, pattern: new RegExp(String.raw`\bRENAME\s+COLUMN\s+${IDENTIFIER}\s+TO\b`, "i") },
  { kind: SchemaChangeKind.RenameColumn, pattern: new RegExp(String.raw`\bCHANGE\s+(?:COLUMN\s+)?${IDENTIFIER}\s+\w`, "i") },
  { kind: SchemaChangeKind.RenameTable, pattern: new RegExp(String.raw`\bRENAME\s+TABLE\s+${IDENTIFIER}\s+TO\b`, "i") },
  { kind: SchemaChangeKind.RenameTable, pattern: new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}\s+RENAME\s+TO\b`, "i") },
  { kind: SchemaChangeKind.ChangeType, pattern: new RegExp(String.raw`\bALTER\s+COLUMN\s+${IDENTIFIER}\s+(?:SET\s+DATA\s+)?TYPE\b`, "i") },
  { kind: SchemaChangeKind.ChangeType, pattern: new RegExp(String.raw`\bMODIFY\s+(?:COLUMN\s+)?${IDENTIFIER}\s+\w`, "i") },
]

/**
 * The call that makes the change → which quoted argument names what changes, counted from the end
 * when negative. Alembic, Rails, Knex, Sequelize and TypeORM spell these differently but their
 * argument lists agree closely enough: the table comes first where there is one.
 *
 * Django's `AlterField` is left out: it can only be judged against the previous field definition,
 * and it mostly changes options such as `help_text`.
 */
const MIGRATION_CALLS: ReadonlyMap<string, { readonly kind: SchemaChangeKind; readonly argument: number }> = new Map([
  ["drop_table", { kind: SchemaChangeKind.DropTable, argument: 0 }],
  ["dropTable", { kind: SchemaChangeKind.DropTable, argument: 0 }],
  ["dropTableIfExists", { kind: SchemaChangeKind.DropTable, argument: 0 }],
  ["DeleteModel", { kind: SchemaChangeKind.DropTable, argument: 0 }],
  ["drop_column", { kind: SchemaChangeKind.DropColumn, argument: -1 }],
  ["dropColumn", { kind: SchemaChangeKind.DropColumn, argument: -1 }],
  ["removeColumn", { kind: SchemaChangeKind.DropColumn, argument: -1 }],
  ["RemoveField", { kind: SchemaChangeKind.DropColumn, argument: -1 }],
  ["remove_column", { kind: SchemaChangeKind.DropColumn, argument: 1 }],
  ["rename_table", { kind: SchemaChangeKind.RenameTable, argument: 0 }],
  ["renameTable", { kind: SchemaChangeKind.RenameTable, argument: 0 }],
  ["RenameModel", { kind: SchemaChangeKind.RenameTable, argument: 0 }],
  ["rename_column", { kind: SchemaChangeKind.RenameColumn, argument: -2 }],
  ["renameColumn", { kind: SchemaChangeKind.RenameColumn, argument: -2 }],
  ["RenameField", { kind: SchemaChangeKind.RenameColumn, argument: -2 }],
  ["change_column", { kind: SchemaChangeKind.ChangeType, argument: 1 }],
  ["changeColumn", { kind: SchemaChangeKind.ChangeType, argument: 1 }],
])
const MIGRATION_CALL = new RegExp(String.raw`(?<![\w])(${[...MIGRATION_CALLS.keys()].join("|")})\b[\s(]`)
const ALEMBIC_ALTER = /\balter_column\s*\(/
const ALEMBIC_RENAMES = /\bnew_column_name\s*=/
const ALEMBIC_RETYPES = /\btype_\s*=/
// `:users`, `"users"` and `'users'`, up to the next option or the end of the call.
const QUOTED_ARGUMENT = /(?<![\w])(?:[a-z_]+\s*=\s*)?(?::|["'`])(\w+)/g
// Django keeps each argument on its own line, so a call's arguments can follow it.
const CALL_LINES = 5
const OPTIONAL_QUALIFIER = String.raw`["'\`\[]?(?:\w+["'\`\]]?\.["'\`\[]?)?`
const CREATES_NAME: readonly RegExp[] = [
  new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${OPTIONAL_QUALIFIER}(\w+)`, "gi"),
  /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi,
  new RegExp(String.raw`\bRENAME\s+TO\s+${OPTIONAL_QUALIFIER}(\w+)`, "gi"),
  /\b(?:create_table|createTable)\b[\s(]+[:"'`](\w+)/g,
  /\b(?:add_column|addColumn)\b[\s(]+[:"'`]\w+["'`]?\s*,\s*[:"'`](\w+)/g,
  /\bColumn\s*\(\s*["'](\w+)/g,
  // Django gives the field's name as an argument, usually some lines into the call.
  /\bmigrations\.(?:AddField|CreateModel)\([^)]*?\bname\s*=\s*["'](\w+)/g,
]

function addedLineNumbers(diff: FileDiff): number[] {
  if (diff.content.kind === FileContentKind.Binary) return []
  return diff.content.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line.kind === DiffLineKind.Added ? [line.newLine] : [])))
}

function isDownSection(lines: readonly string[], index: number): boolean {
  for (let current = index; current >= 0; current--) {
    const line = lines.at(current) ?? ""
    if (DOWN_SECTION.test(line)) return true
    if (UP_SECTION.test(line)) return false
  }
  return false
}

interface FoundChange {
  readonly kind: SchemaChangeKind
  readonly name: string
}

function argumentsOf(call: string): string[] {
  const end = call.indexOf(")")
  return Array.from((end === -1 ? call : call.slice(0, end)).matchAll(QUOTED_ARGUMENT), (match) => match[1] ?? "")
}

function namedCallChange(line: string, following: string): FoundChange | undefined {
  const call = MIGRATION_CALL.exec(line)
  const entry = MIGRATION_CALLS.get(call?.[1] ?? "")
  if (call === null || entry === undefined) return undefined
  const args = argumentsOf(following.slice(call.index))
  const name = args.at(entry.argument) ?? args.at(0)
  return name === undefined ? undefined : { kind: entry.kind, name }
}

// Alembic's `alter_column` covers many changes; its keyword arguments say which this one is.
function alembicAlterChange(line: string, following: string): FoundChange | undefined {
  if (!ALEMBIC_ALTER.test(line)) return undefined
  const end = following.indexOf(")")
  const call = end === -1 ? following : following.slice(0, end)
  const name = argumentsOf(call.replace(/\b\w+\s*=\s*\S+/g, "")).at(-1)
  if (name === undefined) return undefined
  if (ALEMBIC_RENAMES.test(call)) return { kind: SchemaChangeKind.RenameColumn, name }
  return ALEMBIC_RETYPES.test(call) ? { kind: SchemaChangeKind.ChangeType, name } : undefined
}

function changeOnLine(lines: readonly string[], index: number): FoundChange | undefined {
  const line = lines.at(index) ?? ""
  for (const { kind, pattern } of SQL_PATTERNS) {
    const name = pattern.exec(line)?.[1]
    if (name !== undefined) return { kind, name }
  }
  const following = lines.slice(index, index + CALL_LINES).join("\n")
  return namedCallChange(line, following) ?? alembicAlterChange(line, following)
}

function isMigration(file: ScannedFile): boolean {
  const { path, status } = file.diff
  return status !== FileChangeStatus.Deleted && isMigrationPath(path) && !DOWN_FILE.test(path) && !isTestPath(path) && !isThirdParty(file)
}

/** Names this PR's migrations bring into being, which nothing outside the PR can depend on yet. */
function namesCreatedInThisChange(migrations: readonly ScannedFile[]): Set<string> {
  const text = migrations.flatMap((file) => {
    const lines = file.after?.split("\n") ?? []
    return addedLineNumbers(file.diff).map((line) => lines.at(line - 1) ?? "")
  }).join("\n")
  return new Set(CREATES_NAME.flatMap((pattern) => Array.from(text.matchAll(pattern), (match) => (match[1] ?? "").toLowerCase())))
}

/**
 * Finds destructive statements in the up direction of migrations this PR adds or edits. Only added
 * lines count, so a PR touching an old migration isn't blamed for what was already there. Rollback
 * sections are skipped, since they undo the PR's own additions. A dropped name that this PR also
 * creates is left out, which covers the rebuild pattern `DROP TABLE x; ALTER TABLE new_x RENAME TO x`.
 */
export function findSchemaChanges(files: readonly ScannedFile[]): SchemaChange[] {
  const migrations = files.filter(isMigration)
  const created = namesCreatedInThisChange(migrations)
  const changes = migrations.flatMap((file) => {
    const lines = file.after?.split("\n") ?? []
    return addedLineNumbers(file.diff).flatMap((lineNumber) => {
      const index = lineNumber - 1
      const text = lines.at(index) ?? ""
      if (COMMENT_LINE.test(text) || isDownSection(lines, index)) return []
      const change = changeOnLine(lines, index)
      if (change === undefined || THROWAWAY_NAME.test(change.name) || created.has(change.name.toLowerCase())) return []
      return [{ ...change, path: file.diff.path, line: lineNumber, statement: text }]
    })
  })
  // One column dropped from several tables is one decision in that file. The first place stands for the rest.
  return [...new Map(changes.reverse().map((change) => [`${change.path}\0${change.kind}\0${change.name}`, change])).values()].reverse()
}

interface SchemaChangeWording {
  readonly title: (name: string) => string
  /** What breaks, as the sentence a reviewer reads first. */
  readonly breaks: (name: string) => string
  readonly action: string
  /** Whether code still naming the old thing makes this serious rather than worth a look. */
  readonly seriousIfMentioned: boolean
}

const WORDING: Readonly<Record<SchemaChangeKind, SchemaChangeWording>> = {
  [SchemaChangeKind.DropTable]: {
    title: (name) => `Migration drops table ${codeSpan(name)}`,
    breaks: (name) => `Code still reading ${name} fails once this runs, and its data is gone.`,
    action: "Ship the code that stops using it first, and check you have a backup.",
    seriousIfMentioned: true,
  },
  [SchemaChangeKind.DropColumn]: {
    title: (name) => `Migration drops column ${codeSpan(name)}`,
    breaks: (name) => `Code still reading ${name}, including the version running during a deploy, fails once this runs, and its data is gone.`,
    action: "Ship the code that stops using it first, and check you have a backup.",
    seriousIfMentioned: true,
  },
  [SchemaChangeKind.RenameTable]: {
    title: (name) => `Migration renames table ${codeSpan(name)}`,
    breaks: () => "The version of the code running during a deploy still uses the old name, and fails until it is replaced.",
    action: "Consider adding the new name first and removing the old one in a later release.",
    seriousIfMentioned: true,
  },
  [SchemaChangeKind.RenameColumn]: {
    title: (name) => `Migration renames column ${codeSpan(name)}`,
    breaks: () => "The version of the code running during a deploy still uses the old name, and fails until it is replaced.",
    action: "Consider adding the new name first and removing the old one in a later release.",
    seriousIfMentioned: true,
  },
  [SchemaChangeKind.ChangeType]: {
    title: (name) => `Migration changes the type of column ${codeSpan(name)}`,
    breaks: () => "Code that reads or writes the old type may break, and existing values may not convert, or may lock the table while they do.",
    action: "Check that values convert and that running code accepts the new type.",
    seriousIfMentioned: false,
  },
}

export function schemaChangeFinding(change: SchemaChange, mentions: readonly CodeMention[] | undefined): Risk {
  const wording = WORDING[change.kind]
  const mentioned = mentions !== undefined && mentions.length > 0
  const named = mentioned ? ` Code still mentions the name: ${describeMentions(mentions)}.` : ""
  const rule: RuleDescription = {
    id: `breaking.migration-${change.kind}`,
    category: RiskCategory.BreakingChange,
    // A common name like `email` turns up everywhere, so only an unusual one is evidence enough to outrank everything.
    severity: mentioned && wording.seriousIfMentioned && isSpecificName(change.name) ? RiskSeverity.High : RiskSeverity.Medium,
    title: wording.title(change.name),
    detail: `${wording.breaks(change.name)}${named} ${wording.action}`,
  }
  return findingAt(rule, change.path, change.line, change.statement)
}
