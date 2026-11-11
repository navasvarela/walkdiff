import type { FileDiff, Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { scanDangerousApis } from "./dangerousApis.ts"
import { DEFAULT_WALKDIFF_CONFIG } from "../config/walkdiffConfig.ts"
import type { ScannedFile } from "./scannedFile.ts"
import { scanSecrets } from "./secrets.ts"
import { scanSensitivePaths } from "./sensitivePaths.ts"

/** A file added in full, so every line is an added line. */
function addedFile(path: string, content: string): ScannedFile {
  const lines = content.split("\n")
  const diff: FileDiff = {
    status: "added",
    path,
    additions: lines.length,
    deletions: 0,
    content: {
      kind: "text",
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: lines.length,
          section: "",
          lines: lines.map((text, index) => ({ kind: "added", content: text, newLine: index + 1 })),
        },
      ],
    },
  }
  return { diff, noise: null, after: content }
}

function summary(findings: readonly Risk[]): string[] {
  return findings.map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"}`)
}

describe("scanSecrets", () => {
  it("finds provider tokens and redacts them in the evidence", () => {
    const token = `ghp_${"a1B2".repeat(9)}`
    const findings = scanSecrets([addedFile("deploy.yml", `env:\n  TOKEN: ${token}\n`)])
    expect(summary(findings)).toEqual(["secret.github-token@2"])
    expect(findings.at(0)?.evidence).toBe("TOKEN: ghp_…[redacted]")
    expect(findings.at(0)?.evidence).not.toContain(token)
  })

  it("flags hard-coded credentials but not placeholders or documentation examples", () => {
    const content = [
      'password = "hunter2hunter2"',
      'password = "changeme123"',
      'api_key: "${API_KEY_FROM_ENV}"',
      "aws = AKIAIOSFODNN7EXAMPLE",
    ].join("\n")
    expect(summary(scanSecrets([addedFile("settings.py", content)]))).toEqual(["secret.hardcoded-credential@1"])
  })

  it("skips lockfiles and vendored code", () => {
    const file = { ...addedFile("vendor/x/key.pem", "-----BEGIN PRIVATE KEY-----"), noise: { kind: "vendored", reason: "" } } as const
    expect(scanSecrets([file])).toEqual([])
  })
})

describe("scanDangerousApis", () => {
  it("flags risky calls in code but not in comments or strings", async () => {
    const content = [
      "// never call eval(input) here",
      'const label = "eval(x) is dangerous"',
      "const result = eval(userInput)",
      "el.innerHTML = html",
      "const sql = `${db.query(`SELECT * FROM t WHERE id = ${id}`)}`",
    ].join("\n")
    expect(summary(await scanDangerousApis([addedFile("src/app.ts", content)]))).toEqual([
      "js.eval@3",
      "js.raw-html@4",
      "js.sql-template@5",
    ])
  })

  it("knows the safe variant of a risky API", async () => {
    const content = ["data = yaml.load(text, Loader=yaml.SafeLoader)", "other = yaml.load(text)", "subprocess.run(cmd, shell=True)"].join("\n")
    expect(summary(await scanDangerousApis([addedFile("tool.py", content)]))).toEqual(["python.yaml-load@2", "python.subprocess-shell@3"])
  })

  it("flags unsafe Rust and TLS verification switched off", async () => {
    const content = ["fn f() { unsafe { ptr.read() } }", "let c = builder.danger_accept_invalid_certs(true);", 'let s = "unsafe { }";'].join("\n")
    expect(summary(await scanDangerousApis([addedFile("src/net.rs", content)]))).toEqual(["rust.unsafe@1", "rust.tls-disabled@2"])
  })

  it("flags risky Go in code but not in comments or raw strings", async () => {
    const content = [
      "package main",
      "func f() {",
      '\tcmd := exec.Command("sh", "-c", input)',
      "\tcfg := &tls.Config{InsecureSkipVerify: true}",
      "\tpage := template.HTML(comment)",
      '\trows, _ := db.Query(fmt.Sprintf("SELECT * FROM t WHERE id = %s", id))',
      "\tp := unsafe.Pointer(&x)",
      "\t// exec.Command is fine in a comment",
      "\tdoc := `InsecureSkipVerify: true`",
      "}",
    ].join("\n")
    expect(summary(await scanDangerousApis([addedFile("cmd/main.go", content)]))).toEqual(["go.exec@3", "go.tls-disabled@4", "go.unescaped-template@5", "go.sql-format@6", "go.unsafe@7"])
  })

  it("flags risky Java in code but not in comments or strings", async () => {
    const content = [
      "class A {",
      "  void f() throws Exception {",
      "    Runtime.getRuntime().exec(command);",
      "    ObjectInputStream in = new ObjectInputStream(socket.getInputStream());",
      '    statement.executeQuery("SELECT * FROM t WHERE id = " + id);',
      "    client.setHostnameVerifier((host, session) -> true);",
      '    String note = "new ProcessBuilder(x)";',
      "    // new ObjectInputStream(stream) would be unsafe here",
      "  }",
      "}",
    ].join("\n")
    expect(summary(await scanDangerousApis([addedFile("src/main/java/A.java", content)]))).toEqual(["java.exec@3", "java.deserialization@4", "java.sql-concat@5", "java.tls-disabled@6"])
  })
})

describe("scanSensitivePaths", () => {
  it.each([
    [".github/workflows/release.yml", "path.ci-pipeline"],
    ["src/auth/session.ts", "path.auth"],
    ["app/billing/invoice.py", "path.payments"],
    ["db/migrations/0042_add_index.sql", "path.migration"],
    ["db/migrate/20261105120000_add_orders.rb", "path.migration"],
    ["deploy/Dockerfile", "path.infrastructure"],
    ["config/.env.production", "path.secrets-config"],
  ])("rates %s as %s", (path, ruleId) => {
    expect(scanSensitivePaths([addedFile(path, "x")], DEFAULT_WALKDIFF_CONFIG).map((finding) => finding.ruleId)).toEqual([ruleId])
  })

  it("does not mistake look-alike names for sensitive areas", () => {
    expect(scanSensitivePaths([addedFile("src/author.ts", "x"), addedFile("src/sessionless_cache.rs", "x")], DEFAULT_WALKDIFF_CONFIG)).toEqual([])
  })

  it("applies team rules from the config before built-in ones", () => {
    const config = { riskPaths: [{ pattern: "src/ledger/**", severity: "high" as const, reason: "Moves customer funds" }], ignore: [], ai: { allowed: true, providers: null }, scanners: { semgrep: { rules: [] } }, quality: { enabled: true }, coverage: { paths: [] }, dependencies: { private: [], allowedLicenses: null }, feedback: { url: null } }
    const [finding] = scanSensitivePaths([addedFile("src/ledger/post.ts", "x")], config)
    expect(finding).toMatchObject({ severity: "high", title: "Sensitive area (team rule)", detail: "Moves customer funds" })
  })
})
