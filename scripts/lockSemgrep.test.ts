import { describe, expect, it } from "vitest"
import { withoutExcludedPackages } from "./lockSemgrep.ts"

const COMPILED = `anyio==4.16.0 ; sys_platform == 'never' \\
    --hash=sha256:aaa
    # via mcp
attrs==26.1.0 \\
    --hash=sha256:bbb
    # via
    #   jsonschema
    #   semgrep
mcp==2.3.0 ; sys_platform == 'never' \\
    --hash=sha256:ccc
    # via semgrep
typing-extensions==4.15.0 \\
    --hash=sha256:ddd
    # via
    #   mcp
    #   semgrep
`

describe("withoutExcludedPackages", () => {
  it("drops packages behind a never-true marker, and annotations naming them, but keeps the rest", () => {
    expect(withoutExcludedPackages(COMPILED)).toBe(`attrs==26.1.0 \\
    --hash=sha256:bbb
    # via
    #   jsonschema
    #   semgrep
typing-extensions==4.15.0 \\
    --hash=sha256:ddd
    # via
    #   semgrep
`)
  })

  it("leaves a lock with nothing excluded unchanged", () => {
    const lock = "attrs==26.1.0 \\\n    --hash=sha256:bbb\n    # via semgrep\n"
    expect(withoutExcludedPackages(lock)).toBe(lock)
  })
})
