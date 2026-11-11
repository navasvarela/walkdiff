import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { classifyWithGrammar, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, LanguageSpec, PublicDefinitionTest } from "./languageSpec.ts"

const KIND_BY_TYPE_NODE: ReadonlyMap<string, UnitKind> = new Map([
  ["struct_type", UnitKind.Struct],
  ["interface_type", UnitKind.Interface],
])
// Grouped declarations, `type ( … )` and `const ( … )`, hold one spec per name.
const GROUPED_DECLARATIONS: ReadonlySet<string> = new Set(["type_declaration", "const_declaration", "var_declaration"])
const VALUE_SPECS: ReadonlySet<string> = new Set(["const_spec", "var_spec"])
const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Interface])
// `package main` builds a program, so nothing in it can be imported.
const PROGRAM_PACKAGE = "main"
const EXPORTED_NAME = /^\p{Lu}/u

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  member: new Map([["selector_expression", ["field", "operand"]]]),
  path: new Map([["qualified_type", ["name", "package"]]]),
  nameIsUse: new Set(),
  // `Config{Name: x}` sets a field rather than using something called `Name`.
  labels: new Map([["keyed_element", "key"]]),
  bindings: new Map([
    ["parameter_declaration", "name"],
    ["variadic_parameter_declaration", "name"],
    ["var_spec", "name"],
    ["const_spec", "name"],
  ]),
}

function describe(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  switch (node.type) {
    case "function_declaration":
      return namedDefinition(node, UnitKind.Function)
    case "method_declaration":
      return describeMethod(node)
    case "method_elem":
      return container?.kind === UnitKind.Interface ? namedDefinition(node, UnitKind.Method) : undefined
    case "type_spec":
      return namedDefinition(node, KIND_BY_TYPE_NODE.get(node.childForFieldName("type")?.type ?? "") ?? UnitKind.TypeAlias)
    case "type_alias":
      return namedDefinition(node, UnitKind.TypeAlias)
    default:
      return VALUE_SPECS.has(node.type) && container === undefined ? describeValue(node) : undefined
  }
}

// `func (s *Server[T]) Start()` belongs to `Server`, whatever the receiver's name or pointer.
function describeMethod(node: Node): DefinitionHeader | undefined {
  const header = namedDefinition(node, UnitKind.Method)
  const receiverType = node.childForFieldName("receiver")?.namedChildren.at(0)?.childForFieldName("type")
  const owner = receiverType === null || receiverType === undefined ? undefined : typeName(receiverType)
  return header === undefined || owner === undefined ? header : { ...header, owner }
}

function typeName(type: Node): string | undefined {
  if (type.type === "type_identifier") return type.text
  const inner = type.type === "pointer_type" ? type.namedChildren.at(0) : type.type === "generic_type" ? type.childForFieldName("type") : undefined
  return inner === null || inner === undefined ? undefined : typeName(inner)
}

// `const a, b = 1, 2` declares two names in one spec, with nothing to call the unit.
function describeValue(spec: Node): DefinitionHeader | undefined {
  const names = spec.childrenForFieldName("name")
  const nameNode = names.at(0)
  if (names.length !== 1 || nameNode === null || nameNode === undefined) return undefined
  const value = spec.childForFieldName("value")?.namedChildren.at(0)
  const kind = value?.type === "func_literal" ? UnitKind.Function : UnitKind.Constant
  return { kind, name: nameNode.text, nameNode }
}

function outerNode(node: Node): Node {
  const parent = node.parent
  const isOnlySpec = parent !== null && GROUPED_DECLARATIONS.has(parent.type) && parent.namedChildren.filter((child) => child?.type !== "comment").length === 1
  return isOnlySpec ? parent : node
}

function publicDefinitions(root: Node): PublicDefinitionTest {
  const packageName = root.namedChildren.find((child) => child?.type === "package_clause")?.namedChildren.at(0)?.text
  if (packageName === PROGRAM_PACKAGE) return () => false
  return (node, name) => {
    const owner = node.type === "method_declaration" ? describeMethod(node)?.owner : undefined
    return EXPORTED_NAME.test(name) && (owner === undefined || EXPORTED_NAME.test(owner))
  }
}

function parameterKind(parameter: Node): ParameterKind {
  return parameter.type === "variadic_parameter_declaration" ? ParameterKind.Rest : ParameterKind.Required
}

export const goSpec: LanguageSpec = {
  language: SourceLanguage.Go,
  grammar: "tree-sitter-go/tree-sitter-go.wasm",
  separator: ".",
  describe,
  outerNode,
  isAttachedPrefix: () => false,
  isContainer: (kind) => CONTAINERS.has(kind),
  // Function literals hold local code; a package-level `var f = func() {…}` is still one unit.
  isOpaque: (node) => node.type === "func_literal" || node.type === "block",
  childPrefix: (_header, _node, qualifiedName) => qualifiedName,
  normalizeLeaf: (leaf) => leaf.text,
  publicDefinitions,
  identifierTypes: new Set(["identifier", "field_identifier", "type_identifier"]),
  classifyIdentifier: (leaf) => classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  // Go names its receiver like any parameter (`s`, `srv`), so there's no word for "this type".
  selfReceivers: new Set(),
  functionScopeTypes: new Set(["function_declaration", "method_declaration", "func_literal"]),
  isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  // `String()` and `Error()` are often reached through an interface, but they're called by name too.
  isImplicitlyInvoked: () => false,
  shape: {
    functionNode: (definition) => definition,
    returnTypeField: "result",
    parameterKind,
    calls: new Map([["call_expression", { calleeField: "function", suffix: "" }]]),
    // Go returns errors as values, so a bail-out is one of these calls rather than a statement.
    errorCalls: new Set(["panic", "log.Fatal", "log.Fatalf", "log.Fatalln", "log.Panic", "log.Panicf", "os.Exit"]),
    errorTypes: [],
    branchTypes: ["if_statement", "for_statement", "expression_case", "type_case", "communication_case"],
    nestingTypes: ["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement"],
    logicalTypes: ["binary_expression"],
    logicalOperators: new Set(["&&", "||"]),
  },
}
