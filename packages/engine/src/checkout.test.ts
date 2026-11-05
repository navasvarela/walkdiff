import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchCommits } from "./checkout.ts"

// Port 9 (discard) has nothing listening on a test machine, so an https fetch fails fast
// with a connection error, while one rewritten to ssh fails on the protocol instead.
const CLONE_URL = "https://127.0.0.1:9/group/project.git"
const COMMIT = commitShaSchema.parse("a".repeat(40))

describe("fetchCommits", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-fetch-"))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  it("stays on https when the person's git config rewrites https to ssh", async () => {
    // As people set up for cargo or go with private repositories.
    const config = join(dir, "gitconfig")
    await writeFile(config, '[url "git@127.0.0.1:"]\n\tinsteadOf = https://127.0.0.1:9/\n')
    vi.stubEnv("GIT_CONFIG_GLOBAL", config)

    const failure = await fetchCommits({ cacheDir: join(dir, "cache"), cloneUrl: CLONE_URL, credentials: { username: "oauth2", token: "secret" }, commits: [COMMIT] }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ""
    expect(message).not.toContain("transport 'ssh' not allowed")
    expect(message).toContain(CLONE_URL)
  })
})
