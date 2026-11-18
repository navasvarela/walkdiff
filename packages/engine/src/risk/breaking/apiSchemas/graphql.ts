import { extname } from "node:path"
import { Kind, parse, print } from "graphql"
import type { DefinitionNode, FieldDefinitionNode, InputValueDefinitionNode } from "graphql"
import { ApiChangeKind, readFile } from "./apiChange.ts"
import type { ApiChange, ApiSchemaFormat, SchemaFile } from "./apiChange.ts"

/**
 * GraphQL schema files (SDL). Types are compared by name, with `extend type` merged into the type
 * it extends: removed types, fields, arguments and enum values, retyped fields, output fields that
 * can now be null, and inputs that became required. A schema is often split across files, so all
 * the PR's GraphQL files are read as one: a type that moves to another file is compared with
 * itself there, and each change is placed in the file the type is in now.
 */

const SCHEMA_EXTENSIONS: ReadonlySet<string> = new Set([".graphql", ".graphqls", ".gql"])
const NON_NULL = "!"

const TypeKind = { Object: "object", Input: "input", Enum: "enum", Other: "other" } as const
type TypeKind = (typeof TypeKind)[keyof typeof TypeKind]

interface Argument {
  readonly type: string
  readonly hasDefault: boolean
}

interface Member {
  readonly path: string
  readonly type: string
  readonly line: number
  readonly arguments: ReadonlyMap<string, Argument>
  readonly hasDefault: boolean
}

interface TypeDefinition {
  readonly path: string
  readonly kind: TypeKind
  readonly line: number
  readonly members: Map<string, Member>
  readonly values: Set<string>
}

export const GRAPHQL: ApiSchemaFormat = {
  name: "GraphQL",
  matches: (path) => SCHEMA_EXTENSIONS.has(extname(path).toLowerCase()),
  compare: (before, after) => compareSchemas(readSchemas(before), readSchemas(after)),
}

function compareSchemas(old: ReadonlyMap<string, TypeDefinition>, now: ReadonlyMap<string, TypeDefinition>): ApiChange[] {
  return [...old].flatMap(([name, previous]) => {
    const current = now.get(name)
    if (current === undefined) return [{ kind: ApiChangeKind.TypeRemoved, subject: name, path: previous.path, line: null, breaksDeployedClients: true }]
    if (current.kind !== previous.kind) return [{ kind: ApiChangeKind.TypeChanged, subject: name, change: `${previous.kind} to ${current.kind}`, path: current.path, line: current.line, breaksDeployedClients: true }]
    switch (current.kind) {
      case TypeKind.Object:
        return outputMemberChanges(name, previous, current)
      case TypeKind.Input:
        return inputMemberChanges(name, previous, current)
      case TypeKind.Enum:
        return [...previous.values].filter((value) => !current.values.has(value)).map((value) => ({ kind: ApiChangeKind.EnumValueRemoved, subject: `${name}.${value}`, path: current.path, line: current.line, breaksDeployedClients: true }))
      case TypeKind.Other:
        return []
    }
  })
}

/** Fields of object types and interfaces, which clients select and read. */
function outputMemberChanges(typeName: string, previous: TypeDefinition, current: TypeDefinition): ApiChange[] {
  return [...previous.members].flatMap(([name, member]) => {
    const subject = `${typeName}.${name}`
    const now = current.members.get(name)
    if (now === undefined) return [{ kind: ApiChangeKind.FieldRemoved, subject, path: current.path, line: current.line, breaksDeployedClients: true }]
    return [...outputTypeChange(subject, member.type, now), ...argumentChanges(subject, member.arguments, now)]
  })
}

// An output may gain `!` freely: clients that handle null are fine with never getting it.
function outputTypeChange(subject: string, before: string, now: Member): ApiChange[] {
  const { type: after, path, line } = now
  if (withoutNonNull(before) !== withoutNonNull(after)) return [{ kind: ApiChangeKind.TypeChanged, subject, change: `${before} to ${after}`, path, line, breaksDeployedClients: true }]
  return nonNullCount(after) < nonNullCount(before) ? [{ kind: ApiChangeKind.BecameOptional, subject, path, line }] : []
}

// An input may lose `!` freely: clients that always send it still can.
function inputTypeChange(subject: string, before: string, after: string, path: string, line: number): ApiChange[] {
  if (withoutNonNull(before) !== withoutNonNull(after)) return [{ kind: ApiChangeKind.TypeChanged, subject, change: `${before} to ${after}`, path, line, breaksDeployedClients: true }]
  return nonNullCount(after) > nonNullCount(before) ? [{ kind: ApiChangeKind.BecameRequired, subject, path, line, breaksDeployedClients: true }] : []
}

function argumentChanges(fieldName: string, before: ReadonlyMap<string, Argument>, now: Member): ApiChange[] {
  const { arguments: after, path, line } = now
  const removed = [...before.keys()].filter((name) => !after.has(name)).map((name) => ({ kind: ApiChangeKind.FieldRemoved, subject: `${fieldName}(${name}:)`, path, line, breaksDeployedClients: true }))
  const changed = [...after].flatMap(([name, argument]): ApiChange[] => {
    const subject = `${fieldName}(${name}:)`
    const previous = before.get(name)
    if (previous === undefined) return isRequired(argument) ? [{ kind: ApiChangeKind.RequiredAdded, subject, path, line, breaksDeployedClients: true }] : []
    return inputTypeChange(subject, previous.type, argument.type, path, line)
  })
  return [...removed, ...changed]
}

/** Fields of input types, which clients send. */
function inputMemberChanges(typeName: string, before: TypeDefinition, after: TypeDefinition): ApiChange[] {
  const removed = [...before.members.keys()]
    .filter((name) => !after.members.has(name))
    .map((name) => ({ kind: ApiChangeKind.FieldRemoved, subject: `${typeName}.${name}`, path: after.path, line: after.line, breaksDeployedClients: true }))
  const changed = [...after.members].flatMap(([name, member]): ApiChange[] => {
    const subject = `${typeName}.${name}`
    const previous = before.members.get(name)
    if (previous === undefined) return isRequired(member) ? [{ kind: ApiChangeKind.RequiredAdded, subject, path: member.path, line: member.line, breaksDeployedClients: true }] : []
    return inputTypeChange(subject, previous.type, member.type, member.path, member.line)
  })
  return [...removed, ...changed]
}

function isRequired(input: Argument): boolean {
  return input.type.endsWith(NON_NULL) && !input.hasDefault
}

function withoutNonNull(type: string): string {
  return type.replaceAll(NON_NULL, "")
}

function nonNullCount(type: string): number {
  return type.split(NON_NULL).length - 1
}

/** Every type the files define, with `extend` merged in, wherever in the files it is. */
function readSchemas(files: readonly SchemaFile[]): Map<string, TypeDefinition> {
  const types = new Map<string, TypeDefinition>()
  for (const file of files) readFile(file, (text) => addTypes(types, file.path, text))
  return types
}

function addTypes(types: Map<string, TypeDefinition>, path: string, text: string): void {
  // A deleted file is compared as empty, which graphql's parser rejects as a document with nothing in it.
  if (text.trim() === "") return
  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)]
  const lineAt = (offset: number | undefined): number => (offset === undefined ? 1 : lineStarts.findLastIndex((start) => start <= offset) + 1)
  for (const definition of parse(text).definitions) {
    const read = typeParts(definition)
    if (read === undefined) continue
    const type = types.get(read.name) ?? { path, kind: read.kind, line: lineAt(definition.loc?.start), members: new Map(), values: new Set() }
    for (const member of read.fields) type.members.set(member.name.value, memberOf(member, path, lineAt))
    for (const value of read.values) type.values.add(value)
    types.set(read.name, type)
  }
}

interface TypeParts {
  readonly name: string
  readonly kind: TypeKind
  readonly fields: readonly (FieldDefinitionNode | InputValueDefinitionNode)[]
  readonly values: readonly string[]
}

function typeParts(definition: DefinitionNode): TypeParts | undefined {
  switch (definition.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_EXTENSION:
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_EXTENSION:
      return { name: definition.name.value, kind: TypeKind.Object, fields: definition.fields ?? [], values: [] }
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return { name: definition.name.value, kind: TypeKind.Input, fields: definition.fields ?? [], values: [] }
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_EXTENSION:
      return { name: definition.name.value, kind: TypeKind.Enum, fields: [], values: (definition.values ?? []).map((value) => value.name.value) }
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.UNION_TYPE_EXTENSION:
    case Kind.SCALAR_TYPE_DEFINITION:
    case Kind.SCALAR_TYPE_EXTENSION:
      return { name: definition.name.value, kind: TypeKind.Other, fields: [], values: [] }
    default:
      return undefined
  }
}

function memberOf(member: FieldDefinitionNode | InputValueDefinitionNode, path: string, lineAt: (offset: number | undefined) => number): Member {
  const argumentNodes = member.kind === Kind.FIELD_DEFINITION ? (member.arguments ?? []) : []
  return {
    path,
    type: print(member.type),
    line: lineAt(member.loc?.start),
    arguments: new Map(argumentNodes.map((argument) => [argument.name.value, { type: print(argument.type), hasDefault: argument.defaultValue !== undefined }])),
    hasDefault: member.kind === Kind.INPUT_VALUE_DEFINITION && member.defaultValue !== undefined,
  }
}
