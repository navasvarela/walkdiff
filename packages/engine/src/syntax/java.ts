import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { classifyWithGrammar, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, LanguageSpec } from "./languageSpec.ts"
import { parametersByField, returnTypeByField } from "./shape.ts"

const KIND_BY_NODE_TYPE: ReadonlyMap<string, UnitKind> = new Map([
  ["class_declaration", UnitKind.Class],
  ["record_declaration", UnitKind.Class],
  ["interface_declaration", UnitKind.Interface],
  ["annotation_type_declaration", UnitKind.Interface],
  ["enum_declaration", UnitKind.Enum],
  ["method_declaration", UnitKind.Method],
  ["constructor_declaration", UnitKind.Method],
  ["compact_constructor_declaration", UnitKind.Method],
  ["annotation_type_element_declaration", UnitKind.Method],
])
const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Class, UnitKind.Interface, UnitKind.Enum])
// Anonymous classes and lambdas live inside an expression; their methods belong to the code around them.
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set(["object_creation_expression", "lambda_expression", "enum_constant", "block"])
const PUBLIC_MODIFIER = "public"
// Interface members are public whether or not they say so; `private` ones are helpers for default methods.
const PRIVATE_MODIFIER = "private"
const IMPLICITLY_PUBLIC_CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Interface])
// The JVM, the collections and try-with-resources call these; every class has its own.
const IMPLICITLY_INVOKED: ReadonlySet<string> = new Set(["toString", "equals", "hashCode", "close", "compareTo", "main", "finalize"])

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  member: new Map([
    ["method_invocation", ["name", "object"]],
    ["field_access", ["field", "object"]],
    ["method_reference", ["name", "object"]],
  ]),
  path: new Map([
    ["scoped_type_identifier", ["name", "scope"]],
    ["scoped_identifier", ["name", "scope"]],
  ]),
  nameIsUse: new Set(),
  // `@Retry(times = 3)` names an annotation element, not a variable.
  labels: new Map([["element_value_pair", "key"]]),
  bindings: new Map([
    ["formal_parameter", "name"],
    ["variable_declarator", "name"],
    ["catch_formal_parameter", "name"],
    ["enhanced_for_statement", "name"],
    ["inferred_parameters", null],
    ["lambda_expression", "parameters"],
  ]),
}

function describe(node: Node): DefinitionHeader | undefined {
  const kind = KIND_BY_NODE_TYPE.get(node.type)
  return kind === undefined ? undefined : namedDefinition(node, kind)
}

function modifierWords(node: Node): Set<string> {
  const modifiers = node.namedChildren.find((child) => child?.type === "modifiers")
  return new Set(modifiers?.children.filter((child) => child !== null && !child.isNamed).map((child) => child?.text ?? "") ?? [])
}

function isPublicMember(node: Node, _name: string, container: ContainerContext | undefined): boolean {
  const words = modifierWords(node)
  if (container !== undefined && IMPLICITLY_PUBLIC_CONTAINERS.has(container.kind)) return !words.has(PRIVATE_MODIFIER)
  return words.has(PUBLIC_MODIFIER)
}

function parameterKind(parameter: Node): ParameterKind {
  if (parameter.type === "spread_parameter") return ParameterKind.Rest
  return parameter.type === "receiver_parameter" ? ParameterKind.Receiver : ParameterKind.Required
}

export const javaSpec: LanguageSpec = {
  language: SourceLanguage.Java,
  grammar: "tree-sitter-java/tree-sitter-java.wasm",
  separator: ".",
  describe,
  // Annotations sit inside a declaration's `modifiers`, so they're already part of it.
  outerNode: (node) => node,
  isAttachedPrefix: () => false,
  isContainer: (kind) => CONTAINERS.has(kind),
  isOpaque: (node) => OPAQUE_NODE_TYPES.has(node.type),
  childPrefix: (_header, _node, qualifiedName) => qualifiedName,
  normalizeLeaf: (leaf) => leaf.text,
  publicDefinitions: () => isPublicMember,
  identifierTypes: new Set(["identifier", "type_identifier"]),
  classifyIdentifier: (leaf) => classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  selfReceivers: new Set(["this"]),
  callsMembersByBareName: true,
  functionScopeTypes: new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration", "lambda_expression"]),
  isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  isImplicitlyInvoked: (methodName) => IMPLICITLY_INVOKED.has(methodName),
  shape: {
    functionNode: (definition) => definition,
    parameters: parametersByField,
    returnType: returnTypeByField("type"),
    parameterKind,
    calls: new Map([
      ["method_invocation", { calleeField: "name", suffix: "" }],
      ["object_creation_expression", { calleeField: "type", suffix: "" }],
    ]),
    errorCalls: new Set(),
    errorTypes: ["throw_statement"],
    branchTypes: ["if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "switch_label", "catch_clause", "ternary_expression"],
    nestingTypes: ["if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "switch_expression", "try_statement", "try_with_resources_statement"],
    logicalTypes: ["binary_expression"],
    logicalOperators: new Set(["&&", "||"]),
  },
}
