import { RiskSeverity } from "@walkdiff/review-model"
import { apiRule, DESERIALIZATION, SPAWNS_PROCESSES, SQL_INTERPOLATION, TLS_DISABLED } from "../risk/apiRules.ts"
import { catchWith, lastChildOfType } from "../risk/errorHandlers.ts"
import { kotlinSpec } from "../syntax/kotlin.ts"
import { JVM_CATCH_ALL, JVM_ROUTES } from "./jvm.ts"
import type { Language } from "./language.ts"

export const KOTLIN: Language = {
  name: "Kotlin",
  spec: kotlinSpec,
  extensions: [".kt", ".kts"],
  riskyApis: [
    apiRule("kotlin.exec", RiskSeverity.Medium, /\bgetRuntime\(\)\s*\.exec\s*\(|\bProcessBuilder\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
    apiRule("kotlin.deserialization", RiskSeverity.Medium, /\bObjectInputStream\s*\(/, "Java deserialization", DESERIALIZATION),
    apiRule("kotlin.sql-template", RiskSeverity.Medium, /\.(?:executeQuery|executeUpdate|execute|prepareStatement|rawQuery|execSQL)\s*\(\s*"[^"]*\$\{?\w/, "SQL built from a string template", SQL_INTERPOLATION),
    apiRule("kotlin.tls-disabled", RiskSeverity.High, /\bNoopHostnameVerifier\b|\bhostnameVerifier\s*(?:=\s*HostnameVerifier\s*)?\{\s*_\s*,\s*_\s*->\s*true\b/, "TLS verification disabled", TLS_DISABLED),
  ],
  errorHandlers: [
    {
      types: ["catch_block"],
      check: (node) => catchWith(lastChildOfType(node, "block"), node.namedChildren.find((child) => child?.type === "user_type")?.text, JVM_CATCH_ALL),
    },
  ],
  routes: JVM_ROUTES,
}
