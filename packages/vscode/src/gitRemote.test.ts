import { describe, expect, it } from "vitest"
import { hostBranch } from "./gitRemote.ts"

const ORIGIN = { name: "origin", fetchUrl: "git@github.com:me/app.git" }
const UPSTREAM = { name: "upstream", fetchUrl: "git@github.com:acme/app.git" }

describe("hostBranch", () => {
  it("uses the remote and branch name the local branch tracks", () => {
    expect(hostBranch("fix", { remote: "upstream", name: "fix-retries" }, [ORIGIN, UPSTREAM])).toEqual({ remoteUrl: UPSTREAM.fetchUrl, branch: "fix-retries" })
  })

  it("falls back to origin and the local name for a branch that tracks nothing yet", () => {
    expect(hostBranch("fix", undefined, [UPSTREAM, ORIGIN])).toEqual({ remoteUrl: ORIGIN.fetchUrl, branch: "fix" })
  })

  it("uses the only remote there is, by its push URL if it has no fetch URL", () => {
    expect(hostBranch("fix", undefined, [{ name: "mine", pushUrl: "https://gitlab.com/g/app.git" }])).toEqual({ remoteUrl: "https://gitlab.com/g/app.git", branch: "fix" })
  })

  it("finds nothing without a remote", () => {
    expect(hostBranch("fix", undefined, [])).toBeUndefined()
  })
})
