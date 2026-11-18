import { codeSpan, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { findingAt } from "../../scannedFile.ts"
import type { RuleDescription } from "../../scannedFile.ts"

/** What changed in an API's contract, in terms every schema format shares. */
export const ApiChangeKind = {
  /** An HTTP operation or an RPC is gone. */
  OperationRemoved: "operation-removed",
  /** A type, message or enum is gone. */
  TypeRemoved: "type-removed",
  /** A field clients read or send is gone. */
  FieldRemoved: "field-removed",
  EnumValueRemoved: "enum-value-removed",
  TypeChanged: "type-changed",
  /** A new input that clients must now send. */
  RequiredAdded: "required-added",
  /** An input that was optional must now be sent. */
  BecameRequired: "became-required",
  /** An output field that was always there can now be missing or null. */
  BecameOptional: "became-optional",
  /** A protobuf field or enum value keeps its name but changes its number, which the wire format uses. */
  NumberChanged: "number-changed",
} as const
export type ApiChangeKind = (typeof ApiChangeKind)[keyof typeof ApiChangeKind]

/** What changed and where in its file, before the file is known. */
export interface ApiChangeAt {
  readonly kind: ApiChangeKind
  /** What changed, as the schema names it: `GET /users/{id}`, `User.email`, `Search.limit`. */
  readonly subject: string
  /** For a changed type or number, what it was and what it is: "integer to string". */
  readonly change?: string
  /** Where the change shows in its file at head; null when nothing is left there to point at. */
  readonly line: number | null
  /** Set when it breaks clients already deployed, not only code built against the schema. */
  readonly breaksDeployedClients?: boolean
}

export interface ApiChange extends ApiChangeAt {
  /** The file it shows in: the head file, or for what's gone, the file it was in. */
  readonly path: string
}

/** One version of a schema file. A deleted file has empty text at head. */
export interface SchemaFile {
  readonly path: string
  readonly text: string
}

/** A kind of API schema file, and how to compare the PR's files of that kind with their earlier versions. */
export interface ApiSchemaFormat {
  /** How the report names it: "OpenAPI". */
  readonly name: string
  matches(path: string, text: string): boolean
  /**
   * The changes from the merge base's files to the head's that can break a client. `before` holds
   * the files the PR changes or deletes, as they were; `after` holds every file of this kind the PR
   * leaves, new ones included, so a format can follow a type that moved between files. Throws,
   * naming the file, when one can't be read.
   */
  compare(before: readonly SchemaFile[], after: readonly SchemaFile[]): ApiChange[]
}

/** Reads one schema file, naming it in any error so the report can say which file it couldn't read. */
export function readFile<T>(file: SchemaFile, read: (text: string) => T): T {
  try {
    return read(file.text)
  } catch (error: unknown) {
    throw new Error(`${file.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

interface Wording {
  readonly title: (subject: string, change: string | undefined) => string
  readonly breaks: string
}

const WORDING: Readonly<Record<ApiChangeKind, Wording>> = {
  [ApiChangeKind.OperationRemoved]: { title: (subject) => `${subject} removed from the API`, breaks: "Clients that call it will get errors." },
  [ApiChangeKind.TypeRemoved]: { title: (subject) => `Type ${subject} removed`, breaks: "Clients that use it will no longer build or validate." },
  [ApiChangeKind.FieldRemoved]: { title: (subject) => `${subject} removed`, breaks: "Clients that read or send it will break." },
  [ApiChangeKind.EnumValueRemoved]: { title: (subject) => `Enum value ${subject} removed`, breaks: "Clients that send it will be rejected, and those that match on it will miss it." },
  [ApiChangeKind.TypeChanged]: { title: (subject, change) => `${subject} changed type${change === undefined ? "" : ` from ${change}`}`, breaks: "Clients that send or read the old type will break." },
  [ApiChangeKind.RequiredAdded]: { title: (subject) => `${subject} is new and required`, breaks: "Clients that don't send it yet will be rejected." },
  [ApiChangeKind.BecameRequired]: { title: (subject) => `${subject} is now required`, breaks: "Clients that leave it out will be rejected." },
  [ApiChangeKind.BecameOptional]: { title: (subject) => `${subject} can now be missing`, breaks: "Clients that assume it's always there can fail on responses without it." },
  [ApiChangeKind.NumberChanged]: { title: (subject, change) => `${subject} changed number${change === undefined ? "" : ` from ${change}`}`, breaks: "Data written with the old number is read as a different field, or lost, by every client and service still using the old schema." },
}

const ACTION = "Keep the old form alongside the new one until clients have moved, or release it as a new API version."

/** A finding for one API change in `path`, rated higher when it breaks clients already running. */
export function apiChangeFinding(format: ApiSchemaFormat, change: ApiChange): Risk {
  const wording = WORDING[change.kind]
  const subject = codeSpan(change.subject)
  const rule: RuleDescription = {
    id: `breaking.api-${change.kind}`,
    category: RiskCategory.BreakingChange,
    severity: change.breaksDeployedClients === true ? RiskSeverity.High : RiskSeverity.Medium,
    title: `${format.name}: ${wording.title(subject, change.change)}`,
    detail: `${wording.breaks} ${ACTION}`,
  }
  return findingAt(rule, change.path, change.line, change.subject)
}
