import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseCommandLine } from "./args.ts"
import { walkdiffVersion } from "./version.ts"

describe("walkdiff --version", () => {
  it("reads the repository's version when run from source", () => {
    const manifest: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8"))
    expect(manifest).toMatchObject({ name: "walkdiff", version: walkdiffVersion() })
  })

  it.each([[["--version"]], [["-v"]], [["review", "https://github.com/o/r/pull/1", "--version"]]])("answers %j with the version, not a command", (argv) => {
    expect(parseCommandLine(argv, {}).command).toEqual({ kind: "version" })
  })

  it("throws for a manifest without a version, rather than printing nothing", () => {
    expect(() => walkdiffVersion(resolve(import.meta.dirname, "../package.json.missing"))).toThrow()
  })
})
