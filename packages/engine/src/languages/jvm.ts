import { RouteForm } from "../risk/routeSyntax.ts"
import type { RouteSyntax } from "../risk/routeSyntax.ts"

/** What Java and Kotlin share: the JVM's catch-all type, and frameworks that run on both. */
export const JVM_CATCH_ALL = "Throwable"

export const JVM_ROUTES: readonly RouteSyntax[] = [
  // Spring: `@PostMapping("/users")`, `@RequestMapping(value = "/users")`; JAX-RS: `@Path("/users")`.
  { form: RouteForm.Decorator, pattern: /@(?<method>Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?[{[]?\s*"(?<path>[^"]*)"/ },
  { form: RouteForm.Decorator, pattern: /@Path\(\s*"(?<path>[^"]*)"/ },
]
