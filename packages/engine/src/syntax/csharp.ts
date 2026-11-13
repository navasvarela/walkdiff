import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { classifyWithGrammar, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, LanguageSpec } from "./languageSpec.ts"
import { returnTypeByField } from "./shape.ts"

const KIND_BY_NODE_TYPE: ReadonlyMap<string, UnitKind> = new Map([
  ["class_declaration", UnitKind.Class],
  ["record_declaration", UnitKind.Class],
  ["struct_declaration", UnitKind.Struct],
  ["interface_declaration", UnitKind.Interface],
  ["enum_declaration", UnitKind.Enum],
  ["method_declaration", UnitKind.Method],
  ["constructor_declaration", UnitKind.Method],
  ["delegate_declaration", UnitKind.TypeAlias],
  ["namespace_declaration", UnitKind.Module],
])
const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Module, UnitKind.Class, UnitKind.Struct, UnitKind.Interface])
// Lambdas, anonymous methods and objects hold code that belongs to the member around them.
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set(["lambda_expression", "anonymous_method_expression", "anonymous_object_creation_expression", "block", "arrow_expression_clause"])
const FILE_SCOPED_NAMESPACE = "file_scoped_namespace_declaration"
const DESTRUCTOR_PREFIX = "~"
const PUBLIC_MODIFIER = "public"
// Interface members are public whether or not they say so; `private` ones are helpers for default methods.
const PRIVATE_MODIFIER = "private"
const IMPLICITLY_PUBLIC_CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Interface])
const RECEIVER_MODIFIER = "this"
// .NET and the language call these; every type has its own.
const IMPLICITLY_INVOKED: ReadonlySet<string> = new Set(["ToString", "Equals", "GetHashCode", "Dispose", "DisposeAsync", "Main", "CompareTo", "GetEnumerator"])

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  member: new Map([["member_access_expression", ["name", "expression"]]]),
  path: new Map([["qualified_name", ["name", "qualifier"]]]),
  nameIsUse: new Set(),
  labels: new Map(),
  bindings: new Map([
    ["parameter", "name"],
    ["variable_declarator", "name"],
    ["foreach_statement", "left"],
    ["catch_declaration", "name"],
    ["lambda_expression", "parameters"],
  ]),
}

function describe(node: Node): DefinitionHeader | undefined {
  if (node.type === "destructor_declaration") {
    const nameNode = node.childForFieldName("name")
    return nameNode === null ? undefined : { kind: UnitKind.Method, name: `${DESTRUCTOR_PREFIX}${nameNode.text}`, nameNode }
  }
  const kind = KIND_BY_NODE_TYPE.get(node.type)
  const header = kind === undefined ? undefined : namedDefinition(node, kind)
  const fileNamespace = fileScopedNamespaceOf(node)
  return header === undefined || fileNamespace === undefined ? header : { ...header, owner: fileNamespace }
}

// `namespace Acme.Server;` covers the declarations after it in the file without wrapping them.
function fileScopedNamespaceOf(node: Node): string | undefined {
  if (node.parent?.type !== "compilation_unit") return undefined
  for (let sibling = node.previousNamedSibling; sibling !== null; sibling = sibling.previousNamedSibling) {
    if (sibling.type === FILE_SCOPED_NAMESPACE) return sibling.childForFieldName("name")?.text
  }
  return undefined
}

function modifierWords(node: Node): Set<string> {
  return new Set(node.namedChildren.filter((child) => child?.type === "modifier").map((child) => child?.text ?? ""))
}

function isPublicMember(node: Node, _name: string, container: ContainerContext | undefined): boolean {
  if (node.type === "namespace_declaration") return true
  const words = modifierWords(node)
  if (container !== undefined && IMPLICITLY_PUBLIC_CONTAINERS.has(container.kind)) return !words.has(PRIVATE_MODIFIER)
  return words.has(PUBLIC_MODIFIER)
}

// `params int[] rest` sits in the list as a type and a name, not as a `parameter` node.
function parametersOf(fn: Node): Node[] {
  const list = fn.childForFieldName("parameters")
  if (list === null) return []
  return list.namedChildren.filter((child): child is Node => child !== null && (child.type === "parameter" || list.childForFieldName("name")?.id === child.id))
}

function parameterKind(parameter: Node): ParameterKind {
  if (parameter.type !== "parameter") return ParameterKind.Rest
  if (parameter.namedChildren.some((child) => child?.type === "modifier" && child.text === RECEIVER_MODIFIER)) return ParameterKind.Receiver
  return parameter.children.some((child) => child?.type === "=") ? ParameterKind.Optional : ParameterKind.Required
}

export const csharpSpec: LanguageSpec = {
  language: SourceLanguage.CSharp,
  grammar: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  separator: ".",
  describe,
  // Attributes are part of the declaration node, so nothing sits outside it.
  outerNode: (node) => node,
  isAttachedPrefix: () => false,
  isContainer: (kind) => CONTAINERS.has(kind),
  isOpaque: (node) => OPAQUE_NODE_TYPES.has(node.type),
  childPrefix: (_header, _node, qualifiedName) => qualifiedName,
  normalizeLeaf: (leaf) => leaf.text,
  publicDefinitions: () => isPublicMember,
  identifierTypes: new Set(["identifier"]),
  classifyIdentifier: (leaf) => classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  selfReceivers: new Set(["this"]),
  callsMembersByBareName: true,
  functionScopeTypes: new Set(["method_declaration", "constructor_declaration", "local_function_statement", "lambda_expression", "anonymous_method_expression"]),
  isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  isImplicitlyInvoked: (methodName) => IMPLICITLY_INVOKED.has(methodName),
  shape: {
    functionNode: (definition) => definition,
    parameters: parametersOf,
    returnType: returnTypeByField("returns"),
    parameterKind,
    calls: new Map([
      ["invocation_expression", { calleeField: "function", suffix: "" }],
      ["object_creation_expression", { calleeField: "type", suffix: "" }],
    ]),
    errorCalls: new Set(["Environment.Exit", "Environment.FailFast"]),
    errorTypes: ["throw_statement", "throw_expression"],
    branchTypes: ["if_statement", "for_statement", "foreach_statement", "while_statement", "do_statement", "switch_section", "switch_expression_arm", "catch_clause", "conditional_expression"],
    nestingTypes: ["if_statement", "for_statement", "foreach_statement", "while_statement", "do_statement", "switch_statement", "switch_expression", "try_statement"],
    logicalTypes: ["binary_expression"],
    logicalOperators: new Set(["&&", "||"]),
  },
}
