import type { Node } from "web-tree-sitter"

/**
 * C and C++ write a declared name inside nested declarators that read like its type:
 * `char *(*handlers[4])(int)` wraps `handlers` in pointer, array and function declarators.
 * These helpers find the name, and for a function the declarator listing its parameters.
 */

// Where a chain of declarators ends: the name being declared.
const NAME_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "field_identifier",
  "type_identifier",
  "destructor_name",
  "operator_name",
  "operator_cast",
  "qualified_identifier",
  "template_function",
])
// Declarators that hold the next one as their first named child rather than in a `declarator` field.
const WRAPPER_TYPES: ReadonlySet<string> = new Set(["parenthesized_declarator", "reference_declarator", "variadic_declarator", "attributed_declarator"])
const FUNCTION_DECLARATOR = "function_declarator"
const QUALIFIED_NAME = "qualified_identifier"
const TEMPLATE_FUNCTION = "template_function"
const TEMPLATE_TYPE = "template_type"
const SCOPE_SEPARATOR = "::"

export interface DeclaredName {
  readonly name: string
  readonly nameNode: Node
  /**
   * The scope a definition written outside it names: `Server` for `void Server::start()`.
   * It may be a namespace rather than a class; the syntax doesn't tell them apart.
   */
  readonly owner: string | undefined
  /** The declarator listing a function's parameters; undefined when the name isn't a function. */
  readonly functionDeclarator: Node | undefined
}

/** The name a declaration, definition or typedef declares through its first declarator. */
export function declaredName(declaration: Node): DeclaredName | undefined {
  const chain = declaratorChain(declaration)
  const last = chain.at(-1)
  if (last === undefined || !NAME_TYPES.has(last.type)) return undefined
  // `int (*callback)(int)` declares a pointer: the function declarator wraps it rather than the name.
  const parent = chain.at(-2)
  const functionDeclarator = parent?.type === FUNCTION_DECLARATOR ? parent : undefined
  return { ...splitQualifiedName(last), functionDeclarator }
}

function declaratorChain(declaration: Node): Node[] {
  const chain: Node[] = []
  for (let current = declaration.childForFieldName("declarator"); current !== null; current = innerDeclarator(current)) {
    chain.push(current)
    if (NAME_TYPES.has(current.type)) break
  }
  return chain
}

function innerDeclarator(declarator: Node): Node | null {
  return declarator.childForFieldName("declarator") ?? (WRAPPER_TYPES.has(declarator.type) ? declarator.firstNamedChild : null)
}

interface SplitName {
  readonly name: string
  readonly nameNode: Node
  readonly owner: string | undefined
}

// `ns::Server<T>::start` is `start`, owned by `ns::Server`.
function splitQualifiedName(node: Node): SplitName {
  const scopes: string[] = []
  let current = node
  for (let inner = qualifiedParts(current); inner !== undefined; inner = qualifiedParts(current)) {
    if (inner.scope !== null) scopes.push(scopeName(inner.scope))
    current = inner.name
  }
  const name = current.type === TEMPLATE_FUNCTION ? (current.childForFieldName("name")?.text ?? current.text) : current.text
  return { name, nameNode: current, owner: scopes.length === 0 ? undefined : scopes.join(SCOPE_SEPARATOR) }
}

function qualifiedParts(node: Node): { readonly scope: Node | null; readonly name: Node } | undefined {
  const name = node.type === QUALIFIED_NAME ? node.childForFieldName("name") : null
  return name === null ? undefined : { scope: node.childForFieldName("scope"), name }
}

// `Server<T>::start` belongs to `Server`, whatever the template arguments.
function scopeName(scope: Node): string {
  return scope.type === TEMPLATE_TYPE ? (scope.childForFieldName("name")?.text ?? scope.text) : scope.text
}
