import { SourceLanguage, UnitKind } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { declaredName } from "./declarators.ts"
import type { DeclaredName } from "./declarators.ts"
import { classifyWithGrammar, IdentifierUseKind, isBindingWithGrammar, namedDefinition, ParameterKind } from "./languageSpec.ts"
import type { ContainerContext, DefinitionHeader, IdentifierGrammar, IdentifierUse, LanguageSpec } from "./languageSpec.ts"

// One spec serves both languages: C++ adds node types, such as classes and namespaces, that
// the C grammar never produces.

const KIND_BY_SPECIFIER: ReadonlyMap<string, UnitKind> = new Map([
  ["class_specifier", UnitKind.Class],
  ["struct_specifier", UnitKind.Struct],
  ["union_specifier", UnitKind.Struct],
  ["enum_specifier", UnitKind.Enum],
])
const CLASS_KINDS: ReadonlySet<UnitKind> = new Set([UnitKind.Class, UnitKind.Struct])
const CONTAINERS: ReadonlySet<UnitKind> = new Set([UnitKind.Module, UnitKind.Class, UnitKind.Struct])
// Function bodies and lambdas hold local code; a friend declaration names another class's function.
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set(["compound_statement", "lambda_expression", "friend_declaration"])
const TYPEDEF = "type_definition"
const TEMPLATE = "template_declaration"
const FIELD_LIST = "field_declaration_list"
const NAMESPACE = "namespace_definition"
const ACCESS_SPECIFIER = "access_specifier"
const PUBLIC_ACCESS = "public"
const PRIVATE_ACCESS = "private"
const STATIC = "static"
// Names a qualified or templated name wraps, as in `Server::~Server` or `swap<int>`.
const NAME_WRAPPERS: ReadonlySet<string> = new Set(["qualified_identifier", "destructor_name", "template_function"])
// Where the end of a declarator chain declares a name rather than using one.
const DECLARING_PARENTS: ReadonlySet<string> = new Set(["function_declarator", TYPEDEF])
const BARE_USE: IdentifierUse = { kind: IdentifierUseKind.Bare }
const MACRO_NAME = /^[A-Z][A-Z\d_]*$/
// Test frameworks' macros that wrap a test's body: GoogleTest's `TEST(suite, name) {…}` and Boost.Test's.
const TEST_MACROS: ReadonlySet<string> = new Set(["TEST", "TEST_F", "TEST_P", "TYPED_TEST", "TYPED_TEST_P", "BOOST_AUTO_TEST_CASE", "BOOST_FIXTURE_TEST_CASE", "BOOST_DATA_TEST_CASE"])
const TEMPLATE_TYPE = "template_type"
// Past this, a specialization's arguments make its name hard to read; it's measured with the template's name.
const MAX_SPECIALIZATION_NAME = 60
const ELLIPSIS = "…"
// `main`, operators and destructors are called by the runtime or by syntax, never by their name.
const IMPLICITLY_INVOKED = /^(?:main$|operator\b|~)/

const IDENTIFIER_GRAMMAR: IdentifierGrammar = {
  // `->` and `.` both parse as a field expression.
  member: new Map([["field_expression", ["field", "argument"]]]),
  path: new Map([["qualified_identifier", ["name", "scope"]]]),
  nameIsUse: new Set(),
  labels: new Map(),
  bindings: new Map([
    ["parameter_declaration", "declarator"],
    ["optional_parameter_declaration", "declarator"],
    ["declaration", "declarator"],
    ["init_declarator", "declarator"],
    ["pointer_declarator", "declarator"],
    ["array_declarator", "declarator"],
    ["reference_declarator", null],
    ["variadic_declarator", null],
    ["for_range_loop", "declarator"],
  ]),
}

function describe(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  switch (node.type) {
    case "function_definition":
      return describeFunctionDefinition(node, container)
    case "declaration":
    case "field_declaration":
      return describeDeclaration(node, container)
    case TYPEDEF:
      return describeTypedef(node)
    case "alias_declaration":
      return namedDefinition(node, UnitKind.TypeAlias)
    // An anonymous namespace has no name, so its definitions read as the file's own.
    case NAMESPACE:
      return namedDefinition(node, UnitKind.Module)
    case "preproc_function_def":
      return namedDefinition(node, UnitKind.Macro)
    // A `#define` with no value is a header guard or a flag: its name is all there is.
    case "preproc_def":
      return node.childForFieldName("value") === null ? undefined : namedDefinition(node, UnitKind.Macro)
    default:
      return describeSpecifier(node)
  }
}

// `TEST(parser, reads) {…}` and `BENCHMARK(parse) {…}` are macros wrapping a block, which the parser
// reads as functions with no return type. The whole call names them, since the macro's name is shared.
function describeFunctionDefinition(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  const declared = declaredName(node)
  const call = declared?.functionDeclarator
  const isMacroBlock = declared !== undefined && call !== undefined && node.childForFieldName("type") === null && MACRO_NAME.test(declared.name)
  if (!isMacroBlock) return describeFunction(declared, container)
  // In a class it's a macro the parser lost its way in, such as `FMT_TRY {…} FMT_CATCH(…) {…}`
  // inside a method; it stays part of the class.
  if (container !== undefined && CLASS_KINDS.has(container.kind) && !isConstructorOf(container, declared.name)) return undefined
  return { kind: TEST_MACROS.has(declared.name) ? UnitKind.Test : UnitKind.Function, name: squeeze(call.text), nameNode: declared.nameNode }
}

function isConstructorOf(container: ContainerContext, name: string): boolean {
  return container.childPrefix === name || container.childPrefix.endsWith(`::${name}`)
}

function describeFunction(declared: DeclaredName | undefined, container: ContainerContext | undefined): DefinitionHeader | undefined {
  if (declared === undefined) return undefined
  const isMember = declared.owner !== undefined || (container !== undefined && CLASS_KINDS.has(container.kind))
  const header = { kind: isMember ? UnitKind.Method : UnitKind.Function, name: declared.name, nameNode: declared.nameNode }
  return declared.owner === undefined ? header : { ...header, owner: declared.owner }
}

// A prototype or method declaration is a unit, since a header's changes are made of them. So is
// a variable at file or namespace scope; a class's fields are part of the class.
function describeDeclaration(node: Node, container: ContainerContext | undefined): DefinitionHeader | undefined {
  const declared = declaredName(node)
  if (declared?.functionDeclarator !== undefined) return describeFunction(declared, container)
  const isFileScope = container === undefined || container.kind === UnitKind.Module
  const declaresOneVariable = node.type === "declaration" && node.childrenForFieldName("declarator").length === 1
  return declared === undefined || !isFileScope || !declaresOneVariable ? undefined : { kind: UnitKind.Constant, name: declared.name, nameNode: declared.nameNode }
}

// `typedef struct point {…} point_t;` is one unit, named the way code refers to it.
function describeTypedef(node: Node): DefinitionHeader | undefined {
  const declared = declaredName(node)
  if (declared === undefined) return undefined
  const type = node.childForFieldName("type")
  const definedKind = type?.childForFieldName("body") === null ? undefined : KIND_BY_SPECIFIER.get(type?.type ?? "")
  return { kind: definedKind ?? UnitKind.TypeAlias, name: declared.name, nameNode: declared.nameNode }
}

function describeSpecifier(node: Node): DefinitionHeader | undefined {
  const kind = KIND_BY_SPECIFIER.get(node.type)
  const nameNode = node.childForFieldName("name")
  const definesBody = node.childForFieldName("body") !== null
  if (kind === undefined || nameNode === null || !definesBody || node.parent?.type === TYPEDEF) return undefined
  if (nameNode.type !== TEMPLATE_TYPE) return { kind, name: nameNode.text, nameNode }
  return { kind, name: specializationName(nameNode), nameNode: nameNode.childForFieldName("name") ?? nameNode }
}

// `formatter<std::expected<T, E>, Char, std::enable_if_t<…>>` specializes `formatter`; its first
// arguments tell it from the other specializations.
function specializationName(type: Node): string {
  const template = type.childForFieldName("name")?.text ?? ""
  const kept: string[] = []
  for (const argument of type.childForFieldName("arguments")?.namedChildren ?? []) {
    const text = squeeze(argument?.text ?? "")
    if (kept.length > 0 && `${template}<${[...kept, text].join(", ")}>`.length > MAX_SPECIALIZATION_NAME) {
      kept.push(ELLIPSIS)
      break
    }
    kept.push(text)
  }
  return `${template}<${kept.join(", ")}>`
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ")
}

function outerNode(node: Node): Node {
  return node.parent?.type === TEMPLATE ? node.parent : node
}

function isPublicDefinition(node: Node, _name: string, container: ContainerContext | undefined): boolean {
  if (container !== undefined && CLASS_KINDS.has(container.kind)) return memberAccess(node, container.kind) === PUBLIC_ACCESS
  const isStatic = outerNode(node).namedChildren.some((child) => child?.type === "storage_class_specifier" && child.text === STATIC)
  return !isStatic && !isInAnonymousNamespace(node)
}

// Members are private in a `class` and public in a `struct` until an access label says otherwise.
function memberAccess(node: Node, containerKind: UnitKind): string {
  for (let sibling = memberOfClass(node).previousNamedSibling; sibling !== null; sibling = sibling.previousNamedSibling) {
    if (sibling.type === ACCESS_SPECIFIER) return sibling.text
  }
  return containerKind === UnitKind.Struct ? PUBLIC_ACCESS : PRIVATE_ACCESS
}

// A nested type sits inside a field declaration; the access label applies to that.
function memberOfClass(node: Node): Node {
  let member = node
  while (member.parent !== null && member.parent.type !== FIELD_LIST) member = member.parent
  return member
}

function isInAnonymousNamespace(node: Node): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type === NAMESPACE && ancestor.childForFieldName("name") === null) return true
  }
  return false
}

function classifyIdentifier(leaf: Node): IdentifierUse | undefined {
  if (declaresName(leaf)) return undefined
  // `struct node *next` refers to a struct; only `struct node {…}` declares one.
  const parent = leaf.parent
  if (parent !== null && KIND_BY_SPECIFIER.has(parent.type) && parent.childForFieldName("body") === null) return BARE_USE
  return classifyWithGrammar(leaf, IDENTIFIER_GRAMMAR)
}

// The name of `int add(int a)`, `void Server::start()` or `typedef int size;` declares it.
function declaresName(leaf: Node): boolean {
  let name = leaf
  while (name.parent !== null && NAME_WRAPPERS.has(name.parent.type) && name.parent.childForFieldName("scope")?.id !== name.id) name = name.parent
  const parent = name.parent
  return parent !== null && DECLARING_PARENTS.has(parent.type) && parent.childForFieldName("declarator")?.id === name.id
}

function parameterKind(parameter: Node): ParameterKind {
  if (parameter.type === "variadic_parameter" || parameter.type === "variadic_parameter_declaration") return ParameterKind.Rest
  return parameter.type === "optional_parameter_declaration" ? ParameterKind.Optional : ParameterKind.Required
}

function makeSpec(language: SourceLanguage, grammar: string): LanguageSpec {
  return {
    language,
    grammar,
    separator: "::",
    describe,
    outerNode,
    isAttachedPrefix: () => false,
    isContainer: (kind) => CONTAINERS.has(kind),
    isOpaque: (node) => OPAQUE_NODE_TYPES.has(node.type),
    childPrefix: (_header, _node, qualifiedName) => qualifiedName,
    normalizeLeaf: (leaf) => leaf.text,
    publicDefinitions: () => isPublicDefinition,
    identifierTypes: new Set(["identifier", "field_identifier", "type_identifier", "namespace_identifier"]),
    classifyIdentifier,
    selfReceivers: new Set(["this"]),
    callsMembersByBareName: true,
    functionScopeTypes: new Set(["function_definition", "lambda_expression"]),
    isBindingSite: (leaf) => isBindingWithGrammar(leaf, IDENTIFIER_GRAMMAR),
    isImplicitlyInvoked: (methodName) => IMPLICITLY_INVOKED.test(methodName),
    shape: {
      functionNode: (definition) => definition,
      signatureNode: (fn) => declaredName(fn)?.functionDeclarator ?? fn,
      returnTypeField: "type",
      parameterKind,
      calls: new Map([
        ["call_expression", { calleeField: "function", suffix: "" }],
        ["new_expression", { calleeField: "type", suffix: "" }],
      ]),
      errorCalls: new Set(["exit", "abort", "_Exit", "quick_exit", "std::exit", "std::abort", "std::terminate", "std::quick_exit"]),
      errorTypes: ["throw_statement"],
      branchTypes: ["if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "case_statement", "conditional_expression", "catch_clause"],
      nestingTypes: ["if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement", "try_statement"],
      logicalTypes: ["binary_expression"],
      logicalOperators: new Set(["&&", "||", "and", "or"]),
    },
  }
}

export const cSpec = makeSpec(SourceLanguage.C, "tree-sitter-c/tree-sitter-c.wasm")
export const cppSpec = makeSpec(SourceLanguage.Cpp, "tree-sitter-cpp/tree-sitter-cpp.wasm")
