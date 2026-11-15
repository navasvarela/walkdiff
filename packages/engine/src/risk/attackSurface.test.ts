import type { DiffLine, FileDiff, Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { scanAttackSurface } from "./attackSurface.ts"
import type { ScannedFile } from "./scannedFile.ts"

/** The file at head, where lines marked with a leading `+` are the ones the PR adds. */
function changedFile(path: string, marked: string, removed: readonly string[] = []): ScannedFile {
  const lines = marked.split("\n")
  const diffLines: DiffLine[] = [
    ...removed.map((content, index): DiffLine => ({ kind: "removed", content, oldLine: lines.length + index + 1 })),
    ...lines.map((line, index): DiffLine =>
      line.startsWith("+") ? { kind: "added", content: line.slice(1), newLine: index + 1 } : { kind: "context", content: line, oldLine: index + 1, newLine: index + 1 },
    ),
  ]
  const diff: FileDiff = {
    status: "modified",
    path,
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: removed.length,
    content: { kind: "text", hunks: [{ oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, section: "", lines: diffLines }] },
  }
  return { diff, noise: null, after: lines.map((line) => (line.startsWith("+") ? line.slice(1) : line)).join("\n") }
}

function summary(findings: readonly Risk[]): string[] {
  return findings.map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"} ${finding.title}`)
}

describe("scanAttackSurface", () => {
  it("flags a new Express route without the middleware its neighbours use", async () => {
    const file = changedFile("src/routes.ts", [
      'router.get("/users", requireAuth, list)',
      'router.post("/users", requireAuth, create)',
      '+router.delete("/users/:id", remove)',
    ].join("\n"))
    expect(summary(await scanAttackSurface([file]))).toEqual(["endpoint.unguarded@3 New endpoint without the auth its neighbours use: `DELETE /users/:id`"])
  })

  it("only notes a new route when its neighbours declare no auth either, or it declares its own", async () => {
    const open = changedFile("src/public.ts", ['app.get("/health", ok)', 'app.get("/version", ok)', '+app.get("/status", ok)'].join("\n"))
    const guarded = changedFile("src/admin.ts", ['router.get("/a", requireAuth, a)', 'router.get("/b", requireAuth, b)', '+router.get("/c", requireAuth, c)'].join("\n"))
    expect(summary(await scanAttackSurface([open, guarded]))).toEqual(["endpoint.added@3 New endpoint: `GET /status`", "endpoint.added@3 New endpoint: `GET /c`"])
  })

  it("reads auth from FastAPI's decorators and signature, and doesn't take a path for a marker", async () => {
    const file = changedFile("app/api.py", [
      '@router.get("/authors")',
      "async def authors(user = Depends(get_current_user)):",
      "    return []",
      '@router.get("/books")',
      "async def books(user = Depends(get_current_user)):",
      "    return []",
      '+@router.post("/authors")',
      "+async def add_author(body: Author):",
      "+    return body",
    ].join("\n"))
    expect(summary(await scanAttackSurface([file]))).toEqual(["endpoint.unguarded@7 New endpoint without the auth its neighbours use: `POST /authors`"])
  })

  it.each([
    ["Spring", "src/main/java/Api.java", '+  @PostMapping("/orders")', "POST /orders"],
    ["ASP.NET", "Controllers/Orders.cs", '+    [HttpPost("orders")]', "POST orders"],
    ["minimal APIs", "Program.cs", '+app.MapDelete("/orders/{id}", Delete);', "DELETE /orders/{id}"],
    ["Go 1.22", "server.go", '+\tmux.HandleFunc("POST /orders", create)', "POST /orders"],
    ["gin", "server.go", '+\tr.GET("/orders", list)', "GET /orders"],
    ["axum", "src/main.rs", '+    .route("/orders", post(create))', "POST /orders"],
    ["Flask", "app.py", '+@bp.route("/orders")', "ANY /orders"],
  ])("recognises %s routes", async (_framework, path, line, route) => {
    expect(summary(await scanAttackSurface([changedFile(path, line)]))).toEqual([`endpoint.added@1 New endpoint: \`${route}\``])
  })

  it("ignores routes in comments, strings, tests, and routes the PR only moved", async () => {
    const commented = changedFile("src/a.ts", ['+// router.get("/old", handler)', '+const doc = \'router.get("/x", h)\''].join("\n"))
    const test = changedFile("src/routes.test.ts", '+router.get("/fixture", handler)')
    const moved = changedFile("src/b.ts", '+router.get("/users", list)', ['router.get("/users", list)'])
    expect(await scanAttackSurface([commented, test, moved])).toEqual([])
  })

  it.each([
    ["requireAuth", true],
    ["isAuthenticated", true],
    ["[Authorize(Roles = Admin)]", true],
    ["@PreAuthorize(hasRole)", true],
    ["@login_required", true],
    ["author", false],
    ["hasAuthority", false],
    ["Author", false],
  ])("treats %s as an auth marker: %s", async (marker, isMarker) => {
    const file = changedFile("src/routes.ts", ['router.get("/a", requireAuth, a)', 'router.get("/b", requireAuth, b)', `+router.get("/c", ${marker}, c)`].join("\n"))
    expect((await scanAttackSurface([file])).at(0)?.ruleId).toBe(isMarker ? "endpoint.added" : "endpoint.unguarded")
  })

  it.each([
    ["[AllowAnonymous]", "Controllers/A.cs", "+    [AllowAnonymous]"],
    ["permitAll()", "src/main/java/Security.java", '+      .requestMatchers("/admin/**").permitAll()'],
    ["@csrf_exempt", "app/views.py", "+@csrf_exempt"],
    ["AllowAny", "app/views.py", "+    permission_classes = [AllowAny]"],
  ])("flags code that turns checks off: %s", async (_case, path, line) => {
    expect(summary(await scanAttackSurface([changedFile(path, line)]))).toEqual(["endpoint.auth-opt-out@1 Turns off an auth or CSRF check"])
  })
})
