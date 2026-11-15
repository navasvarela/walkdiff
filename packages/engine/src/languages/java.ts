import { RiskSeverity } from "@walkdiff/review-model"
import { apiRule, DESERIALIZATION, SPAWNS_PROCESSES, SQL_INTERPOLATION, TLS_DISABLED } from "../risk/apiRules.ts"
import { catchWith } from "../risk/errorHandlers.ts"
import { javaSpec } from "../syntax/java.ts"
import { JVM_CATCH_ALL, JVM_ROUTES } from "./jvm.ts"
import type { Language } from "./language.ts"

export const JAVA: Language = {
  name: "Java",
  spec: javaSpec,
  extensions: [".java"],
  riskyApis: [
    apiRule("java.exec", RiskSeverity.Medium, /\bgetRuntime\(\)\s*\.exec\s*\(|\bnew\s+ProcessBuilder\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
    apiRule("java.deserialization", RiskSeverity.Medium, /\bnew\s+ObjectInputStream\s*\(/, "Java deserialization", DESERIALIZATION),
    apiRule("java.sql-concat", RiskSeverity.Medium, /\.(?:executeQuery|executeUpdate|execute|prepareStatement|addBatch)\s*\(\s*"[^"]*"\s*\+/, "SQL built by concatenation", SQL_INTERPOLATION),
    apiRule("java.tls-disabled", RiskSeverity.High, /\bNoopHostnameVerifier\b|\bALLOW_ALL_HOSTNAME_VERIFIER\b|\bsetHostnameVerifier\s*\(\s*\([^)]*\)\s*->\s*true\b/, "TLS verification disabled", TLS_DISABLED),
  ],
  errorHandlers: [
    {
      types: ["catch_clause"],
      check: (node) => catchWith(node.childForFieldName("body"), node.namedChildren.find((child) => child?.type === "catch_formal_parameter")?.text, JVM_CATCH_ALL),
    },
  ],
  routes: JVM_ROUTES,
}
