import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { classifyWithGrammar, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, LanguageSpec, PublicDefinitionTest } from "./languageSpec.ts"
import { describeTestStatement, leadsIntoTestSuite } from "./testCalls.ts"

const KIND_BY_NODE_TYPE: ReadonlyMap<string, UnitKind> = new Map([
  ["function_declaration", UnitKind.Function],
  ["generator_function_declaration", UnitKind.Function],
  ["function_signature", UnitKind.Function],
  ["class_declaration", UnitKind.Class],
  ["abstract_class_declaration", UnitKind.Class],
  ["interface_declaration", UnitKind.Interface],
  ["type_alias_declaration", UnitKind.TypeAlias],
  ["enum_declaration", UnitKind.Enum],
  ["internal_module", UnitKind.Module],
  ["method_definition", UnitKind.Method],
  ["abstract_method_signature", UnitKind.Method],
])
const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "generator_function"])
const VARIABLE_DECLARATION_TYPES: ReadonlySet<string> = new Set(["lexical_declaration", "variable_declaration"])
// A `const` counts as a unit only at module or namespace level; one inside a callback
// passed to `describe(...)`, say, is part of that call, not a definition of its own.
const MODULE_LEVEL_PARENTS: ReadonlySet<string> = new Set(["program", "export_statement", "statement_block"])
const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Class, UnitKind.Module, UnitKind.TestSuite])
// Function bodies and call arguments hold local code, never module-level definitions.
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set([
  "call_expression",
  "arrow_function",
  "function_expression",
  "statement_block",
])
const STRING_DELIMITERS: ReadonlySet<string> = new Set(["'", '"'])

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  member: new Map([["member_expression", ["property", "object"]]]),
  path: new Map([["nested_type_identifier", ["name", "module"]]]),
  // `import { parse } from "./x"` uses `parse`; it does not declare a new thing.
  nameIsUse: new Set(["import_specifier", "export_specifier"]),
  labels: new Map([["pair", "key"]]),
  bindings: new Map([
    ["required_parameter", "pattern"],
    ["optional_parameter", "pattern"],
    ["variable_declarator", "name"],
    ["arrow_function", "parameter"],
    ["catch_clause", "parameter"],
    ["for_in_statement", "left"],
  ]),
}
const FUNCTION_SCOPE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
])

function describe(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  if (node.type === "expression_statement") {
    return describeTestStatement(node)
  }
  if (node.type === "variable_declarator") {
    return describeVariable(node, container)
  }
  if (node.type === "public_field_definition") {
    // Class fields holding arrow functions are methods in all but syntax.
    const value = node.childForFieldName("value")
    return value !== null && FUNCTION_VALUE_TYPES.has(value.type) ? namedDefinition(node, UnitKind.Method) : undefined
  }
  const kind = KIND_BY_NODE_TYPE.get(node.type)
  return kind === undefined ? undefined : namedDefinition(node, kind)
}

function describeVariable(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  const declaration = node.parent
  const atModuleLevel =
    declaration !== null &&
    VARIABLE_DECLARATION_TYPES.has(declaration.type) &&
    MODULE_LEVEL_PARENTS.has(declaration.parent?.type ?? "") &&
    (container === undefined || container.kind === UnitKind.Module)
  const nameNode = node.childForFieldName("name")
  // Destructuring declarations (`const { a, b } = ...`) have no single name to track.
  if (!atModuleLevel || nameNode === null || nameNode.type !== "identifier") {
    return undefined
  }
  const value = node.childForFieldName("value")
  const kind = value !== null && FUNCTION_VALUE_TYPES.has(value.type) ? UnitKind.Function : UnitKind.Constant
  return { kind, name: nameNode.text, nameNode }
}

function outerNode(node: Node): Node {
  let outer = node
  const parent = node.parent
  if (node.type === "variable_declarator" && parent !== null && declaresOnlyOneName(parent)) {
    outer = parent
  }
  return outer.parent?.type === "export_statement" ? outer.parent : outer
}

function declaresOnlyOneName(declaration: Node): boolean {
  return declaration.namedChildren.filter((child) => child?.type === "variable_declarator").length === 1
}

// Protected members count as private: only subclasses see them, and those are rarely outside the repository.
const NON_PUBLIC_MODIFIERS: ReadonlySet<string> = new Set(["private", "protected"])
const EXPORT_BOUNDARIES: ReadonlySet<string> = new Set(["program", "statement_block"])

function publicDefinitions(root: Node): PublicDefinitionTest {
  const exported = locallyExportedNames(root)
  return (node, name, container) => {
    if (node.type === "expression_statement") return false
    if (container?.kind === UnitKind.Class) return isPublicMember(node)
    return isInsideExportStatement(node) || (container === undefined && exported.has(name))
  }
}

function isPublicMember(node: Node): boolean {
  const name = node.childForFieldName("name")
  const modifier = node.children.find((child) => child?.type === "accessibility_modifier")
  return name?.type !== "private_property_identifier" && !NON_PUBLIC_MODIFIERS.has(modifier?.text ?? "")
}

function isInsideExportStatement(node: Node): boolean {
  for (let current = node.parent; current !== null && !EXPORT_BOUNDARIES.has(current.type); current = current.parent) {
    if (current.type === "export_statement") return true
  }
  return false
}

/** `export { a, b as c }` and `export default a` export definitions declared elsewhere in the file. */
function locallyExportedNames(root: Node): Set<string> {
  const names = new Set<string>()
  for (const statement of root.namedChildren) {
    if (statement?.type !== "export_statement" || statement.childForFieldName("source") !== null) continue
    const defaultValue = statement.childForFieldName("value")
    if (defaultValue?.type === "identifier") names.add(defaultValue.text)
    for (const specifier of statement.descendantsOfType("export_specifier")) {
      const local = specifier?.childForFieldName("name")?.text
      if (local !== undefined) names.add(local)
    }
  }
  return names
}

function parameterKind(parameter: Node): ParameterKind {
  if (parameter.type === "optional_parameter" || parameter.childForFieldName("value") !== null) return ParameterKind.Optional
  return parameter.childForFieldName("pattern")?.type === "rest_pattern" || parameter.type === "rest_pattern" ? ParameterKind.Rest : ParameterKind.Required
}

function makeSpec(language: SourceLanguage, grammar: string): LanguageSpec {
  return {
    language,
    grammar,
    separator: ".",
    describe,
    outerNode,
    isAttachedPrefix: (node) => node.type === "decorator",
    isContainer: (kind) => CONTAINERS.has(kind),
    // A namespace body is a statement_block too, so it stays transparent, and so does the way into
    // a test suite's callback, where its tests are.
    isOpaque: (node) => OPAQUE_NODE_TYPES.has(node.type) && node.parent?.type !== "internal_module" && !leadsIntoTestSuite(node),
    childPrefix: (_header, _node, qualifiedName) => qualifiedName,
    // Prettier and linters flip quote styles wholesale; 'a' and "a" are the same string.
    normalizeLeaf: (leaf) => (STRING_DELIMITERS.has(leaf.type) && leaf.parent?.type === "string" ? '"' : leaf.text),
    publicDefinitions,
    identifierTypes: new Set(["identifier", "property_identifier", "type_identifier", "shorthand_property_identifier"]),
    classifyIdentifier: (leaf) => classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR),
    selfReceivers: new Set(["this"]),
    functionScopeTypes: FUNCTION_SCOPE_TYPES,
    isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
    isImplicitlyInvoked: (methodName) => methodName === "constructor",
    shape: {
      // `const f = () => {}` and class fields keep their parameters on the assigned function.
      functionNode: (definition) => definition.childForFieldName("value") ?? definition,
      returnTypeField: "return_type",
      parameterKind,
      calls: new Map([
        ["call_expression", { calleeField: "function", suffix: "" }],
        ["new_expression", { calleeField: "constructor", suffix: "" }],
      ]),
      errorCalls: new Set(),
      errorTypes: ["throw_statement"],
      branchTypes: ["if_statement", "switch_case", "for_statement", "for_in_statement", "while_statement", "do_statement", "ternary_expression", "catch_clause"],
      nestingTypes: ["if_statement", "switch_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "try_statement"],
      logicalTypes: ["binary_expression"],
      logicalOperators: new Set(["&&", "||", "??"]),
    },
  }
}

export const typescriptSpec = makeSpec(SourceLanguage.TypeScript, "tree-sitter-typescript/tree-sitter-typescript.wasm")
export const tsxSpec = makeSpec(SourceLanguage.Tsx, "tree-sitter-typescript/tree-sitter-tsx.wasm")
