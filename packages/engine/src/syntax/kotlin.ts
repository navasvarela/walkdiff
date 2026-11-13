import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { classifyWithGrammar, IdentifierUseKind, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, IdentifierUse, LanguageSpec } from "./languageSpec.ts"

// Kotlin's grammar gives few nodes field names, so declarations and calls are read by position.

const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Class, UnitKind.Interface, UnitKind.Enum])
// Lambdas, anonymous functions and objects, and enum entries' bodies hold code that belongs to
// the declaration around them.
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set(["lambda_literal", "anonymous_function", "object_literal", "enum_entry", "function_body"])
const INTERFACE_KEYWORD = "interface"
const ENUM_MODIFIER = "enum"
// Members are public unless one of these says otherwise.
const HIDDEN_VISIBILITIES: ReadonlySet<string> = new Set(["private", "internal", "protected"])
const COMPANION_NAME = "Companion"
const PARAMETER_LIST = "function_value_parameters"
const VARARG = "vararg"
// What can follow a function's parameters as its declared return type.
const TYPE_NODES: ReadonlySet<string> = new Set(["user_type", "nullable_type", "function_type", "parenthesized_type"])
// The JVM and operator syntax call these; every class has its own.
const IMPLICITLY_INVOKED: ReadonlySet<string> = new Set(["toString", "equals", "hashCode", "main", "compareTo", "close", "invoke"])

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  member: new Map(),
  path: new Map(),
  nameIsUse: new Set(),
  // `typealias Handler = …` names its alias in a field called `type`.
  labels: new Map([["type_alias", "type"]]),
  bindings: new Map([
    ["parameter", null],
    ["class_parameter", null],
    ["variable_declaration", null],
    ["catch_block", null],
  ]),
}

function describe(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  switch (node.type) {
    case "class_declaration":
      return namedDefinition(node, classKind(node))
    case "object_declaration":
      return namedDefinition(node, UnitKind.Class)
    // `companion object` may go unnamed, and Kotlin then calls it Companion.
    case "companion_object":
      return namedDefinition(node, UnitKind.Class) ?? { kind: UnitKind.Class, name: COMPANION_NAME, nameNode: null }
    case "function_declaration":
      return describeFunction(node, container)
    case "secondary_constructor":
      return { kind: UnitKind.Method, name: "constructor", nameNode: null }
    case "type_alias": {
      const nameNode = node.childForFieldName("type")
      return nameNode === null ? undefined : { kind: UnitKind.TypeAlias, name: nameNode.text, nameNode }
    }
    case "property_declaration":
      return container === undefined ? describeTopLevelProperty(node) : undefined
    default:
      return undefined
  }
}

// `interface`, `enum class` and `data class` are all class declarations to the grammar.
function classKind(node: Node): UnitKind {
  if (node.children.some((child) => child !== null && !child.isNamed && child.type === INTERFACE_KEYWORD)) return UnitKind.Interface
  return modifierWords(node).has(ENUM_MODIFIER) ? UnitKind.Enum : UnitKind.Class
}

// An extension function, `fun String.shout()`, is named by the type it extends, as Go's methods are.
function describeFunction(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  const header = namedDefinition(node, container === undefined ? UnitKind.Function : UnitKind.Method)
  const nameNode = node.childForFieldName("name")
  const receiver = nameNode?.previousNamedSibling
  if (header === undefined || container !== undefined || receiver === null || receiver === undefined || !TYPE_NODES.has(receiver.type)) return header
  return { ...header, owner: receiver.text }
}

function describeTopLevelProperty(node: Node): DefinitionHeader | undefined {
  const nameNode = node.namedChildren.find((child) => child?.type === "variable_declaration")?.namedChildren.find((child) => child?.type === "identifier")
  return nameNode === null || nameNode === undefined ? undefined : { kind: UnitKind.Constant, name: nameNode.text, nameNode }
}

function modifierWords(node: Node): Set<string> {
  const modifiers = node.namedChildren.find((child) => child?.type === "modifiers")
  return new Set(modifiers?.namedChildren.map((modifier) => modifier?.text ?? "") ?? [])
}

function isPublicDeclaration(node: Node): boolean {
  return ![...modifierWords(node)].some((word) => HIDDEN_VISIBILITIES.has(word))
}

// `obj.call` and `Server.create` are navigation expressions with no field names: the receiver comes first.
function classifyIdentifier(leaf: Node): IdentifierUse | undefined {
  const parent = leaf.parent
  if (parent?.type === "navigation_expression" && parent.firstNamedChild?.id !== leaf.id) {
    return { kind: IdentifierUseKind.Member, receiver: parent.firstNamedChild?.text ?? "" }
  }
  return classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR)
}

function parametersOf(fn: Node): Node[] {
  const list = fn.namedChildren.find((child) => child?.type === PARAMETER_LIST)
  return (list?.namedChildren ?? []).filter((child): child is Node => child?.type === "parameter")
}

function returnTypeOf(fn: Node): Node | null {
  const next = fn.namedChildren.find((child) => child?.type === PARAMETER_LIST)?.nextNamedSibling ?? null
  return next !== null && TYPE_NODES.has(next.type) ? next : null
}

// `vararg` and a default value sit beside the parameter rather than inside it.
function parameterKind(parameter: Node): ParameterKind {
  const before = parameter.previousNamedSibling
  if (before?.type === "parameter_modifiers" && before.text.split(/\s+/).includes(VARARG)) return ParameterKind.Rest
  return parameter.nextSibling?.type === "=" ? ParameterKind.Optional : ParameterKind.Required
}

export const kotlinSpec: LanguageSpec = {
  language: SourceLanguage.Kotlin,
  grammar: "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
  separator: ".",
  describe,
  // Annotations sit inside a declaration's `modifiers`, so they're already part of it.
  outerNode: (node) => node,
  isAttachedPrefix: () => false,
  isContainer: (kind) => CONTAINERS.has(kind),
  isOpaque: (node) => OPAQUE_NODE_TYPES.has(node.type),
  childPrefix: (_header, _node, qualifiedName) => qualifiedName,
  normalizeLeaf: (leaf) => leaf.text,
  publicDefinitions: () => isPublicDeclaration,
  identifierTypes: new Set(["identifier"]),
  classifyIdentifier,
  selfReceivers: new Set(["this"]),
  callsMembersByBareName: true,
  functionScopeTypes: new Set(["function_declaration", "secondary_constructor", "lambda_literal", "anonymous_function"]),
  isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  isImplicitlyInvoked: (methodName) => IMPLICITLY_INVOKED.has(methodName),
  shape: {
    functionNode: (definition) => definition,
    parameters: parametersOf,
    returnType: returnTypeOf,
    parameterKind,
    calls: new Map([["call_expression", { calleeField: undefined, suffix: "" }]]),
    // `error()` and `TODO()` throw, and `exitProcess` ends the program.
    errorCalls: new Set(["error", "TODO", "exitProcess"]),
    errorTypes: ["throw_expression"],
    branchTypes: ["if_expression", "when_entry", "for_statement", "while_statement", "do_while_statement", "catch_block"],
    nestingTypes: ["if_expression", "when_expression", "for_statement", "while_statement", "do_while_statement", "try_expression"],
    logicalTypes: ["binary_expression"],
    logicalOperators: new Set(["&&", "||"]),
  },
}
