import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { classifyWithGrammar, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, LanguageSpec } from "./languageSpec.ts"

const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Class])

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  member: new Map([["attribute", ["attribute", "object"]]]),
  path: new Map(),
  nameIsUse: new Set(),
  // `f(timeout=3)` names a parameter, and `import x as y` declares `y`; neither refers to a unit.
  labels: new Map([
    ["keyword_argument", "name"],
    ["aliased_import", "alias"],
  ]),
  bindings: new Map([
    ["parameters", null],
    ["lambda_parameters", null],
    ["default_parameter", "name"],
    ["typed_parameter", null],
    ["typed_default_parameter", "name"],
    ["assignment", "left"],
    ["for_statement", "left"],
  ]),
}
// Dunder methods (`__init__`, `__eq__`) are invoked by the interpreter, not by name.
const DUNDER_METHOD = /^__\w+__$/
const PARAMETER_KINDS: ReadonlyMap<string, ParameterKind> = new Map([
  ["default_parameter", ParameterKind.Optional],
  ["typed_default_parameter", ParameterKind.Optional],
  ["list_splat_pattern", ParameterKind.Rest],
  ["dictionary_splat_pattern", ParameterKind.KeywordRest],
  ["keyword_separator", ParameterKind.KeywordOnlyMarker],
  ["positional_separator", ParameterKind.PositionalOnlyMarker],
])

function parameterKind(parameter: Node): ParameterKind {
  // `*args: int` is a typed parameter wrapping the splat.
  const inner = parameter.type === "typed_parameter" ? parameter.firstNamedChild : parameter
  return PARAMETER_KINDS.get(inner?.type ?? "") ?? ParameterKind.Required
}

// Python has no access modifiers: a leading underscore is how a name says it is private.
// Dunder names are protocol hooks, reached through the language rather than by name.
function isPublicName(name: string): boolean {
  return !name.startsWith("_") || DUNDER_METHOD.test(name)
}

export const pythonSpec: LanguageSpec = {
  language: SourceLanguage.Python,
  grammar: "tree-sitter-python/tree-sitter-python.wasm",
  separator: ".",

  describe(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
    switch (node.type) {
      case "function_definition":
        return namedDefinition(node, container?.kind === UnitKind.Class ? UnitKind.Method : UnitKind.Function)
      case "class_definition":
        return namedDefinition(node, UnitKind.Class)
      default:
        return undefined
    }
  },

  // Decorators live inside a decorated_definition wrapping the function or class.
  outerNode: (node) => (node.parent?.type === "decorated_definition" ? node.parent : node),
  isAttachedPrefix: () => false,
  isContainer: (kind) => CONTAINERS.has(kind),
  isOpaque: (node) => node.type === "call" || node.type === "lambda",
  childPrefix: (_header, _node, qualifiedName) => qualifiedName,
  normalizeLeaf: (leaf) => leaf.text,
  publicDefinitions: () => (_node, name) => isPublicName(name),
  identifierTypes: new Set(["identifier"]),
  classifyIdentifier: (leaf) => classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  selfReceivers: new Set(["self", "cls"]),
  functionScopeTypes: new Set(["function_definition", "lambda"]),
  isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
  isImplicitlyInvoked: (methodName) => DUNDER_METHOD.test(methodName),
  shape: {
    functionNode: (definition) => definition,
    returnTypeField: "return_type",
    parameterKind,
    calls: new Map([["call", { calleeField: "function", suffix: "" }]]),
    errorCalls: new Set(),
    errorTypes: ["raise_statement"],
    branchTypes: ["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause", "conditional_expression", "case_clause"],
    nestingTypes: ["if_statement", "for_statement", "while_statement", "try_statement", "with_statement"],
    logicalTypes: ["boolean_operator"],
    logicalOperators: new Set(["and", "or"]),
  },
}
