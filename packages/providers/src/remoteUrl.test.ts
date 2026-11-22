import { describe, expect, it } from "vitest"
import { InvalidRemoteUrlError, parseRemoteUrl } from "./remoteUrl.ts"

const TRUSTED = { github: ["https://github.example.com"], gitlab: ["https://code.example.com"] }

describe("parseRemoteUrl", () => {
  it.each([
    ["git@github.com:acme/app.git", { host: "github", webOrigin: "https://github.com", owner: "acme", repo: "app" }],
    ["https://github.com/acme/app", { host: "github", webOrigin: "https://github.com", owner: "acme", repo: "app" }],
    ["https://user:secret@github.com/acme/app.git", { host: "github", webOrigin: "https://github.com", owner: "acme", repo: "app" }],
    ["ssh://git@github.com/acme/app.git", { host: "github", webOrigin: "https://github.com", owner: "acme", repo: "app" }],
    ["github.com:acme/app", { host: "github", webOrigin: "https://github.com", owner: "acme", repo: "app" }],
    ["git@github.example.com:acme/app.git", { host: "github", webOrigin: "https://github.example.com", owner: "acme", repo: "app" }],
    ["git@gitlab.com:group/sub/app.git", { host: "gitlab", webOrigin: "https://gitlab.com", projectPath: "group/sub/app" }],
    ["ssh://git@code.example.com:2222/group/app.git", { host: "gitlab", webOrigin: "https://code.example.com", projectPath: "group/app" }],
  ])("reads %s", (remote, expected) => {
    expect(parseRemoteUrl(remote, TRUSTED)).toEqual(expected)
  })

  it.each([
    ["git@git.example.org:acme/app.git", "can't tell whether https://git.example.org"],
    ["http://github.com/acme/app.git", "can't tell whether http://github.com"],
    ["git@github.com:acme/app/extra.git", "owner/repo"],
    ["git@gitlab.com:app.git", "group/project"],
    ["/home/me/app.git", "HTTPS or SSH"],
    ["git://github.com/acme/app.git", "HTTPS or SSH"],
  ])("refuses %s", (remote, message) => {
    expect(() => parseRemoteUrl(remote, TRUSTED)).toThrow(InvalidRemoteUrlError)
    expect(() => parseRemoteUrl(remote, TRUSTED)).toThrow(message)
  })

  it("never repeats a token from the remote", () => {
    expect(() => parseRemoteUrl("https://me:hunter2@git.example.org/acme/app.git", TRUSTED)).toThrow(/^(?!.*hunter2)/)
  })
})
