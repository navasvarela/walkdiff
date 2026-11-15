import { RiskSeverity } from "@walkdiff/review-model"
import { apiRule, SPAWNS_PROCESSES, SQL_INTERPOLATION, TLS_DISABLED } from "../risk/apiRules.ts"
import { EMPTY_CATCH_BODY } from "../risk/errorHandlers.ts"
import { RouteForm } from "../risk/routeSyntax.ts"
import { csharpSpec } from "../syntax/csharp.ts"
import type { Language } from "./language.ts"

export const CSHARP: Language = {
  name: "C#",
  spec: csharpSpec,
  extensions: [".cs"],
  riskyApis: [
    apiRule("csharp.exec", RiskSeverity.Medium, /\bProcess\.Start\s*\(|\bnew\s+ProcessStartInfo\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
    apiRule(
      "csharp.deserialization",
      RiskSeverity.High,
      /\bnew\s+(?:BinaryFormatter|NetDataContractSerializer|SoapFormatter|LosFormatter)\s*\(|\bTypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects|Arrays)\b/,
      "Unsafe deserialization",
      "These serializers can create any type the data names, which lets whoever wrote it run code. Use System.Text.Json, or keep TypeNameHandling at None.",
    ),
    apiRule("csharp.sql-interpolation", RiskSeverity.Medium, /\b(?:new\s+SqlCommand|ExecuteSqlRaw(?:Async)?|FromSqlRaw|ExecuteSqlCommand)\s*\(\s*(?:\$"|"[^"]*"\s*\+)/, "SQL built from interpolation", SQL_INTERPOLATION),
    apiRule(
      "csharp.tls-disabled",
      RiskSeverity.High,
      /\b(?:ServerCertificateCustomValidationCallback|ServerCertificateValidationCallback)\s*\+?=\s*(?:\([^)]*\)|\w+)\s*=>\s*true\b|\bDangerousAcceptAnyServerCertificateValidator\b/,
      "TLS verification disabled",
      TLS_DISABLED,
    ),
    apiRule("csharp.unsafe", RiskSeverity.Medium, /\bunsafe\s*(?:\{|\w)/, "unsafe code", "The runtime no longer checks memory safety here; review the pointer arithmetic and lifetimes the code relies on."),
  ],
  errorHandlers: [EMPTY_CATCH_BODY],
  routes: [
    // ASP.NET: `[HttpPost("users")]`, and minimal APIs: `app.MapPost("/users", …)`.
    { form: RouteForm.Decorator, pattern: /\[Http(?<method>Get|Post|Put|Patch|Delete)\(\s*"(?<path>[^"]*)"/ },
    { form: RouteForm.Call, pattern: /\.Map(?<method>Get|Post|Put|Patch|Delete)\s*\(\s*"(?<path>[^"]+)"/ },
  ],
}
