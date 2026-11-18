import { extname } from "node:path"
import { isMap, isScalar, LineCounter, parseDocument } from "yaml"
import type { Document } from "yaml"
import { field, isRecord, recordOrEmpty, stringField } from "../../dependencies/fields.ts"
import { ApiChangeKind, readFile } from "./apiChange.ts"
import type { ApiChangeAt, ApiSchemaFormat } from "./apiChange.ts"

/**
 * OpenAPI 3 and Swagger 2 specs, in YAML or JSON. Each operation is compared with its earlier
 * version: removed operations, new or newly required parameters and request fields, removed or
 * retyped response fields, and enum values clients can no longer send. Only the top level of a
 * request or response body is compared, after following `$ref`s and `allOf` within the file.
 */

const SPEC_EXTENSIONS: ReadonlySet<string> = new Set([".yaml", ".yml", ".json"])
// The version key starts a line, or follows a JSON spec's opening brace: `{ "swagger": "2.0"`.
const SPEC_MARKER = /^\s*\{?\s*["']?(?:openapi|swagger)["']?\s*:/m
const HTTP_METHODS: ReadonlySet<string> = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])
const SUCCESS_STATUS = /^2(?:\d\d|XX)$/
const JSON_MEDIA_TYPE = "application/json"
const LOCAL_REF = "#/"
// Specs are untrusted input, and `$ref` chains can loop; real ones are a few levels deep.
const MAX_REF_DEPTH = 32

/** One parameter, request field or response field, as clients see it. */
interface Field {
  readonly required: boolean
  readonly type: string | undefined
  readonly enumValues: readonly string[]
}

interface Operation {
  /** `GET /users/{id}`. */
  readonly name: string
  readonly path: string
  readonly method: string
  /** Keyed by where and name: `query limit`. */
  readonly parameters: ReadonlyMap<string, Field>
  readonly bodyRequired: boolean
  readonly requestFields: ReadonlyMap<string, Field>
  readonly responseFields: ReadonlyMap<string, Field>
}

interface Spec {
  readonly operations: ReadonlyMap<string, Operation>
  readonly lineOf: (keys: readonly string[]) => number | null
}

export const OPEN_API: ApiSchemaFormat = {
  name: "OpenAPI",
  matches: (path, text) => SPEC_EXTENSIONS.has(extname(path).toLowerCase()) && SPEC_MARKER.test(text),
  // A spec describes one API, so each file is compared with its own earlier version.
  compare: (before, after) =>
    before.flatMap((old) => {
      const now = after.find((file) => file.path === old.path) ?? { path: old.path, text: "" }
      return compareSpecs(readFile(old, readSpec), readFile(now, readSpec)).map((change) => ({ ...change, path: old.path }))
    }),
}

function compareSpecs(old: Spec, now: Spec): ApiChangeAt[] {
  return [...old.operations.values()].flatMap((previous): ApiChangeAt[] => {
    const current = now.operations.get(previous.name)
    if (current === undefined) {
      return [{ kind: ApiChangeKind.OperationRemoved, subject: previous.name, line: now.lineOf(["paths", previous.path]), breaksDeployedClients: true }]
    }
    const line = now.lineOf(["paths", current.path, current.method])
    return [
      ...inputChanges(previous.parameters, current.parameters, (key) => `${current.name} ${key} parameter`, line),
      ...(!previous.bodyRequired && current.bodyRequired ? [{ kind: ApiChangeKind.BecameRequired, subject: `${current.name} request body`, line }] : []),
      ...inputChanges(previous.requestFields, current.requestFields, (name) => `${current.name} request: ${name}`, line),
      ...outputChanges(previous.responseFields, current.responseFields, (name) => `${current.name} response: ${name}`, line),
    ]
  })
}

/** What clients send: they break when something new is required, or a value they send stops being accepted. */
function inputChanges(old: ReadonlyMap<string, Field>, now: ReadonlyMap<string, Field>, subjectOf: (key: string) => string, line: number | null): ApiChangeAt[] {
  return [...now].flatMap(([key, current]) => {
    const subject = subjectOf(key)
    const previous = old.get(key)
    if (previous === undefined) return current.required ? [{ kind: ApiChangeKind.RequiredAdded, subject, line }] : []
    const removedValues = previous.enumValues.filter((value) => current.enumValues.length > 0 && !current.enumValues.includes(value))
    return [
      ...(!previous.required && current.required ? [{ kind: ApiChangeKind.BecameRequired, subject, line }] : []),
      ...typeChange(previous, current, subject, line),
      ...removedValues.map((value) => ({ kind: ApiChangeKind.EnumValueRemoved, subject: `${subject} = ${value}`, line })),
    ]
  })
}

/** What clients read: they break when a field they read is gone, retyped or no longer always there. */
function outputChanges(old: ReadonlyMap<string, Field>, now: ReadonlyMap<string, Field>, subjectOf: (key: string) => string, line: number | null): ApiChangeAt[] {
  return [...old].flatMap(([key, previous]) => {
    const subject = subjectOf(key)
    const current = now.get(key)
    if (current === undefined) return [{ kind: ApiChangeKind.FieldRemoved, subject, line, breaksDeployedClients: true }]
    return [...(previous.required && !current.required ? [{ kind: ApiChangeKind.BecameOptional, subject, line }] : []), ...typeChange(previous, current, subject, line)]
  })
}

function typeChange(previous: Field, current: Field, subject: string, line: number | null): ApiChangeAt[] {
  if (previous.type === undefined || current.type === undefined || previous.type === current.type) return []
  return [{ kind: ApiChangeKind.TypeChanged, subject, change: `${previous.type} to ${current.type}`, line }]
}

function readSpec(text: string): Spec {
  const lineCounter = new LineCounter()
  const document = parseDocument(text, { lineCounter })
  const [error] = document.errors
  if (error !== undefined) throw error
  const spec: unknown = document.toJS()
  const operations = new Map<string, Operation>()
  for (const [path, item] of Object.entries(recordOrEmpty(field(spec, "paths")))) {
    const shared = arrayOf(field(item, "parameters"))
    for (const [method, operation] of Object.entries(recordOrEmpty(item))) {
      if (!HTTP_METHODS.has(method)) continue
      const read = readOperation(spec, path, method, operation, shared)
      operations.set(read.name, read)
    }
  }
  return { operations, lineOf: (keys) => lineOfKeys(document, lineCounter, keys) }
}

function readOperation(spec: unknown, path: string, method: string, operation: unknown, shared: readonly unknown[]): Operation {
  const parameters = new Map<string, Field>()
  let bodyRequired = false
  let bodySchema: unknown
  // Operation parameters override the path's own of the same name and place.
  for (const raw of [...shared, ...arrayOf(field(operation, "parameters"))]) {
    const parameter = resolve(spec, raw)
    const name = stringField(parameter, "name")
    const place = stringField(parameter, "in")
    if (name === undefined || place === undefined) continue
    if (place === "body") {
      bodySchema = field(parameter, "schema")
      bodyRequired = field(parameter, "required") === true
      continue
    }
    const schema = field(parameter, "schema") ?? parameter
    parameters.set(`${place} ${name}`, { required: field(parameter, "required") === true || place === "path", type: typeOf(spec, schema), enumValues: enumOf(spec, schema) })
  }
  const requestBody = resolve(spec, field(operation, "requestBody"))
  if (requestBody !== undefined) {
    bodySchema = mediaSchema(field(requestBody, "content"))
    bodyRequired = field(requestBody, "required") === true
  }
  return {
    name: `${method.toUpperCase()} ${path}`,
    path,
    method,
    parameters,
    bodyRequired,
    requestFields: fieldsOf(spec, bodySchema),
    responseFields: fieldsOf(spec, successSchema(spec, field(operation, "responses"))),
  }
}

// OpenAPI 3 puts a body's schema under its media type, Swagger 2 directly on the response.
function successSchema(spec: unknown, responses: unknown): unknown {
  const status = Object.keys(recordOrEmpty(responses)).filter((code) => SUCCESS_STATUS.test(code)).sort().at(0)
  if (status === undefined) return undefined
  const response = resolve(spec, field(responses, status))
  return field(response, "schema") ?? mediaSchema(field(response, "content"))
}

function mediaSchema(content: unknown): unknown {
  const media = recordOrEmpty(content)
  return field(media[JSON_MEDIA_TYPE] ?? Object.values(media).at(0), "schema")
}

/** The top-level fields of a body schema, through `$ref`, `allOf` and, for a list, its items. */
function fieldsOf(spec: unknown, schema: unknown): Map<string, Field> {
  const fields = new Map<string, Field>()
  const resolved = resolve(spec, schema)
  if (field(resolved, "type") === "array") return fieldsOf(spec, field(resolved, "items"))
  const parts = [resolved, ...arrayOf(field(resolved, "allOf")).map((part) => resolve(spec, part))]
  const required = new Set(parts.flatMap((part) => arrayOf(field(part, "required")).filter((name): name is string => typeof name === "string")))
  for (const part of parts) {
    for (const [name, property] of Object.entries(recordOrEmpty(field(part, "properties")))) {
      fields.set(name, { required: required.has(name), type: typeOf(spec, property), enumValues: enumOf(spec, property) })
    }
  }
  return fields
}

function typeOf(spec: unknown, schema: unknown, depth = 0): string | undefined {
  const reference = stringField(schema, "$ref")
  const resolved = resolve(spec, schema)
  const type = field(resolved, "type")
  if (type === "array" && depth < MAX_REF_DEPTH) return `array of ${typeOf(spec, field(resolved, "items"), depth + 1) ?? "anything"}`
  if (typeof type === "string") return type
  if (Array.isArray(type)) return type.join(" or ")
  // An object with no type of its own is named by its reference, so pointing it elsewhere is a change.
  return reference?.split("/").at(-1)
}

function enumOf(spec: unknown, schema: unknown): string[] {
  return arrayOf(field(resolve(spec, schema), "enum")).map(String)
}

/** Follows a local `$ref` such as `#/components/schemas/User`; other references are left as they are. */
function resolve(spec: unknown, value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < MAX_REF_DEPTH; depth++) {
    const reference = stringField(current, "$ref")
    if (reference?.startsWith(LOCAL_REF) !== true) return current
    current = reference
      .slice(LOCAL_REF.length)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((node, segment) => (isRecord(node) ? node[segment] : undefined), spec)
  }
  return current
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The line of the deepest of `keys` the document still has, so a removed item points at what holds it. */
function lineOfKeys(document: Document, lineCounter: LineCounter, keys: readonly string[]): number | null {
  let node: unknown = document.contents
  let line: number | null = null
  for (const key of keys) {
    if (!isMap(node)) break
    const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === key)
    if (pair === undefined || !isScalar(pair.key) || pair.key.range === undefined || pair.key.range === null) break
    line = lineCounter.linePos(pair.key.range[0]).line
    node = pair.value
  }
  return line
}
