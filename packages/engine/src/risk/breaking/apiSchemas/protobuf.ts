import { extname } from "node:path"
import { ApiChangeKind, readFile } from "./apiChange.ts"
import type { ApiChange, ApiSchemaFormat, SchemaFile } from "./apiChange.ts"

/**
 * Protocol Buffers schemas (`.proto`). Messages, enums and services are compared by their full
 * name, with the package: removed or retyped RPCs, fields and enum values whose number changed,
 * retyped fields, and fields or values removed without reserving their number. The wire format
 * identifies a field by its number, so a changed number breaks every client and service already
 * deployed, while a removed name breaks code built against the schema.
 *
 * All the PR's `.proto` files are read as one, so a message moved to another file is compared with
 * itself there. This reads only what a contract consists of; options, extensions and groups are
 * skipped.
 */

const PROTO_EXTENSION = ".proto"
// The largest field number protobuf allows, which `reserved 10 to max` means.
const MAX_FIELD_NUMBER = 536_870_911
const FIELD_LABELS: ReadonlySet<string> = new Set(["optional", "repeated", "required"])

interface Field {
  readonly type: string
  readonly number: number
  readonly line: number
}

/** Field numbers no new field may take, as inclusive ranges. */
interface Reserved {
  readonly ranges: [number, number][]
}

interface MessageLike {
  readonly path: string
  readonly line: number
  /** Fields of a message, or values of an enum, whose `type` is empty. */
  readonly fields: Map<string, Field>
  readonly reserved: Reserved
}

interface Rpc {
  readonly path: string
  readonly request: string
  readonly response: string
  readonly line: number
}

interface Schema {
  readonly messages: Map<string, MessageLike>
  readonly enums: Map<string, MessageLike>
  readonly rpcs: Map<string, Rpc>
}

export const PROTOBUF: ApiSchemaFormat = {
  name: "Protobuf",
  matches: (path) => extname(path).toLowerCase() === PROTO_EXTENSION,
  compare: (before, after) => compareSchemas(readProtos(before), readProtos(after)),
}

function compareSchemas(old: Schema, now: Schema): ApiChange[] {
  return [
    ...rpcChanges(old.rpcs, now.rpcs),
    ...definitionChanges(old.messages, now.messages, "field"),
    ...definitionChanges(old.enums, now.enums, "value"),
  ]
}

function rpcChanges(old: ReadonlyMap<string, Rpc>, now: ReadonlyMap<string, Rpc>): ApiChange[] {
  return [...old].flatMap(([name, previous]): ApiChange[] => {
    const current = now.get(name)
    if (current === undefined) return [{ kind: ApiChangeKind.OperationRemoved, subject: name, path: previous.path, line: null, breaksDeployedClients: true }]
    const before = `${previous.request} → ${previous.response}`
    const after = `${current.request} → ${current.response}`
    return before === after ? [] : [{ kind: ApiChangeKind.TypeChanged, subject: name, change: `${before} to ${after}`, path: current.path, line: current.line, breaksDeployedClients: true }]
  })
}

function definitionChanges(old: ReadonlyMap<string, MessageLike>, now: ReadonlyMap<string, MessageLike>, member: "field" | "value"): ApiChange[] {
  return [...old].flatMap(([name, previous]): ApiChange[] => {
    const current = now.get(name)
    if (current === undefined) return [{ kind: ApiChangeKind.TypeRemoved, subject: name, path: previous.path, line: null }]
    return [...previous.fields].flatMap(([fieldName, field]) => memberChanges(`${name}.${fieldName}`, field, current, fieldName, member))
  })
}

function memberChanges(subject: string, previous: Field, current: MessageLike, name: string, member: "field" | "value"): ApiChange[] {
  const now = current.fields.get(name)
  if (now === undefined) {
    // Renamed in place keeps the wire format but breaks generated code and JSON; a number that's
    // neither in use nor reserved can be taken by a later field, which then reads old data wrongly.
    const renamed = [...current.fields.values()].some((field) => field.number === previous.number)
    if (!renamed && isReserved(current.reserved, previous.number)) return []
    return [{ kind: member === "field" ? ApiChangeKind.FieldRemoved : ApiChangeKind.EnumValueRemoved, subject, path: current.path, line: current.line }]
  }
  const path = current.path
  const line = now.line
  return [
    ...(now.number === previous.number ? [] : [{ kind: ApiChangeKind.NumberChanged, subject, change: `${previous.number} to ${now.number}`, path, line, breaksDeployedClients: true }]),
    ...(now.type === previous.type ? [] : [{ kind: ApiChangeKind.TypeChanged, subject, change: `${previous.type} to ${now.type}`, path, line, breaksDeployedClients: true }]),
  ]
}

function isReserved(reserved: Reserved, number: number): boolean {
  return reserved.ranges.some(([low, high]) => number >= low && number <= high)
}

interface Token {
  readonly text: string
  readonly line: number
}

// Identifiers with dots, numbers, quoted strings, and single symbols; comments are dropped.
const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_.][\w.]*|-?\d+|\S/g

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let line = 1
  let lastIndex = 0
  for (const match of text.matchAll(TOKEN)) {
    line += countNewlines(text, lastIndex, match.index)
    lastIndex = match.index
    if (!match[0].startsWith("//") && !match[0].startsWith("/*")) tokens.push({ text: match[0], line })
  }
  return tokens
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let index = text.indexOf("\n", from); index !== -1 && index < to; index = text.indexOf("\n", index + 1)) count++
  return count
}

/** Reads tokens front to back; each read method consumes what it reads. */
class ProtoReader {
  private position = 0
  private readonly tokens: readonly Token[]
  private readonly path: string
  private readonly schema: Schema

  /** Adds what one file defines to `schema`, which the PR's other files add to as well. */
  constructor(schema: Schema, path: string, text: string) {
    this.schema = schema
    this.path = path
    this.tokens = tokenize(text)
  }

  readFile(): void {
    let scope = ""
    while (!this.atEnd()) {
      const word = this.next().text
      if (word === "package") {
        scope = `${this.next().text}.`
        this.expect(";")
      }
      else if (word === "message") this.readMessage(scope)
      else if (word === "enum") this.readEnum(scope)
      else if (word === "service") this.readService(scope)
      else if (this.peek() === "{") this.skipBlock()
      else this.skipStatement()
    }
  }

  private readMessage(scope: string): void {
    const { text: name, line } = this.next()
    const fullName = `${scope}${name}`
    const message: MessageLike = { path: this.path, line, fields: new Map(), reserved: { ranges: [] } }
    this.schema.messages.set(fullName, message)
    this.expect("{")
    this.readMembers(message, `${fullName}.`)
  }

  private readMembers(message: MessageLike, scope: string): void {
    while (!this.atEnd() && this.peek() !== "}") {
      const word = this.peek()
      if (word === "option" || word === "extensions" || word === "extend" || word === "group") {
        this.skipStatementOrBlock()
        continue
      }
      if (word !== "message" && word !== "enum" && word !== "oneof" && word !== "reserved") {
        this.readField(message)
        continue
      }
      this.next()
      if (word === "message") this.readMessage(scope)
      else if (word === "enum") this.readEnum(scope)
      else if (word === "reserved") this.readReserved(message.reserved)
      else {
        // A oneof's fields belong to the message around it.
        this.next()
        this.expect("{")
        this.readMembers(message, scope)
      }
    }
    this.next()
  }

  private readField(message: MessageLike): void {
    const first = this.next()
    const label = FIELD_LABELS.has(first.text) ? `${first.text} ` : ""
    const type = label === "" ? this.readType(first.text) : this.readType(this.next().text)
    const name = this.next().text
    if (this.peek() === "=") {
      this.next()
      message.fields.set(name, { type: `${label}${type}`, number: Number(this.next().text), line: first.line })
    }
    this.skipStatement()
  }

  // `map<string, int32>` is several tokens.
  private readType(first: string): string {
    if (first !== "map" || this.peek() !== "<") return first
    const parts: string[] = []
    while (!this.atEnd() && this.peek() !== ">") parts.push(this.next().text)
    this.next()
    return `map${parts.join("").replace(",", ", ")}>`
  }

  private readEnum(scope: string): void {
    const { text: name, line } = this.next()
    const values: MessageLike = { path: this.path, line, fields: new Map(), reserved: { ranges: [] } }
    this.schema.enums.set(`${scope}${name}`, values)
    this.expect("{")
    while (!this.atEnd() && this.peek() !== "}") {
      const token = this.next()
      if (token.text === "reserved") this.readReserved(values.reserved)
      else if (token.text === "option") this.skipStatement()
      else if (this.peek() === "=") {
        this.next()
        values.fields.set(token.text, { type: "", number: Number(this.next().text), line: token.line })
        this.skipStatement()
      } else this.skipStatement()
    }
    this.next()
  }

  // `reserved 2, 15, 9 to 11, 40 to max;`. Reserved names (`reserved "foo";`) only guard against
  // reuse by name, which the comparison doesn't need.
  private readReserved(reserved: Reserved): void {
    while (!this.atEnd() && this.peek() !== ";") {
      const token = this.next().text
      if (token === "," || /^["']/.test(token)) continue
      const low = Number(token)
      if (this.peek() === "to") {
        this.next()
        const end = this.next().text
        reserved.ranges.push([low, end === "max" ? MAX_FIELD_NUMBER : Number(end)])
      } else reserved.ranges.push([low, low])
    }
    this.next()
  }

  private readService(scope: string): void {
    const service = `${scope}${this.next().text}`
    this.expect("{")
    while (!this.atEnd() && this.peek() !== "}") {
      const token = this.next()
      if (token.text !== "rpc") {
        this.skipStatementOrBlock()
        continue
      }
      const name = this.next().text
      const request = this.readRpcType()
      this.next()
      const response = this.readRpcType()
      this.schema.rpcs.set(`${service}.${name}`, { path: this.path, request, response, line: token.line })
      this.skipStatementOrBlock()
    }
    this.next()
  }

  // `(stream Request)`.
  private readRpcType(): string {
    this.expect("(")
    const parts: string[] = []
    while (!this.atEnd() && this.peek() !== ")") parts.push(this.next().text)
    this.next()
    return parts.join(" ")
  }

  // An option's value can be a block: `option (x) = { a: 1 };`, ending with `;` after it.
  private skipStatementOrBlock(): void {
    while (!this.atEnd() && this.peek() !== ";" && this.peek() !== "{") this.next()
    if (this.peek() === "{") this.skipBlock()
    if (this.peek() === ";") this.next()
  }

  private skipStatement(): void {
    let depth = 0
    while (!this.atEnd()) {
      const text = this.next().text
      if (text === "[" || text === "(") depth++
      else if (text === "]" || text === ")") depth--
      else if (text === ";" && depth <= 0) return
    }
  }

  private skipBlock(): void {
    let depth = 0
    while (!this.atEnd()) {
      const text = this.next().text
      if (text === "{") depth++
      else if (text === "}" && --depth === 0) return
    }
  }

  private expect(text: string): void {
    const token = this.next()
    if (token.text !== text) throw new SyntaxError(`expected "${text}" on line ${token.line}, found "${token.text}"`)
  }

  private peek(): string | undefined {
    return this.tokens[this.position]?.text
  }

  private next(): Token {
    const token = this.tokens[this.position]
    if (token === undefined) throw new SyntaxError("the file ends in the middle of a definition")
    this.position++
    return token
  }

  private atEnd(): boolean {
    return this.position >= this.tokens.length
  }
}

function readProtos(files: readonly SchemaFile[]): Schema {
  const schema: Schema = { messages: new Map(), enums: new Map(), rpcs: new Map() }
  for (const file of files) readFile(file, (text) => new ProtoReader(schema, file.path, text).readFile())
  return schema
}
