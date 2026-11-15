/** Where a route's auth is declared, which says which lines to look for it on. */
export const RouteForm = {
  /** `router.get("/users", requireAuth, list)`: in the same call, so only on the route's own line. */
  Call: "call",
  /** `@app.get("/users")`: in the decorators above it, or the signature just below. */
  Decorator: "decorator",
} as const
export type RouteForm = (typeof RouteForm)[keyof typeof RouteForm]

/** One way a framework declares an HTTP route. Each language lists its frameworks' syntaxes. */
export interface RouteSyntax {
  readonly form: RouteForm
  /** Named groups: `path`, and `method` when the syntax names one. */
  readonly pattern: RegExp
}
