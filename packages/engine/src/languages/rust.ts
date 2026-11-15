import { RiskSeverity } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { apiRule, SPAWNS_PROCESSES, TLS_DISABLED, UNCHECKED_CAST } from "../risk/apiRules.ts"
import { rustSurface } from "../risk/breaking/librarySurface.ts"
import { MAY_PANIC } from "../risk/errorHandlers.ts"
import type { RuleDescription } from "../risk/scannedFile.ts"
import { RouteForm } from "../risk/routeSyntax.ts"
import { rustSpec } from "../syntax/rust.ts"
import type { Language } from "./language.ts"

const PANICKING_METHODS: ReadonlySet<string> = new Set(["unwrap", "expect"])
const TEST_MODULE = "tests"
const TEST_ATTRIBUTE = /#\[(?:tokio::)?test\b/

function panics(node: Node): RuleDescription | undefined {
  const callee = node.childForFieldName("function")
  const method = callee?.type === "field_expression" ? callee.childForFieldName("field")?.text : undefined
  return method !== undefined && PANICKING_METHODS.has(method) && !isInTest(node) ? MAY_PANIC : undefined
}

function isInTest(node: Node): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type === "mod_item" && ancestor.childForFieldName("name")?.text === TEST_MODULE) return true
    if (ancestor.type === "function_item" && TEST_ATTRIBUTE.test(ancestor.previousNamedSibling?.text ?? "")) return true
  }
  return false
}

export const RUST: Language = {
  name: "Rust",
  spec: rustSpec,
  extensions: [".rs"],
  riskyApis: [
    apiRule("rust.unsafe", RiskSeverity.Medium, /\bunsafe\s*(?:\{|fn\b|impl\b|trait\b)/, "unsafe code", "The compiler no longer checks memory safety here; review the invariants the code relies on."),
    apiRule("rust.transmute", RiskSeverity.Medium, /\b(?:mem::)?transmute\s*(?:::<|\()/, "mem::transmute", UNCHECKED_CAST),
    apiRule("rust.command", RiskSeverity.Medium, /\bCommand::new\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
    apiRule("rust.tls-disabled", RiskSeverity.High, /\bdanger_accept_invalid_(?:certs|hostnames)\s*\(\s*true/, "TLS verification disabled", TLS_DISABLED),
  ],
  errorHandlers: [{ types: ["call_expression"], check: panics }],
  routes: [
    // axum: `.route("/users", post(create))`; actix and Rocket: `#[post("/users")]`.
    { form: RouteForm.Call, pattern: /\.route\s*\(\s*"(?<path>[^"]+)"\s*,\s*(?<method>get|post|put|patch|delete)\b/ },
    { form: RouteForm.Decorator, pattern: /#\[(?<method>get|post|put|patch|delete)\s*\(\s*"(?<path>[^"]+)"/ },
  ],
  librarySurface: rustSurface,
}
