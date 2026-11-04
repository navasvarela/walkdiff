import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = resolve(import.meta.dirname, "../../..")
const read = (path: string): Promise<string> => readFile(resolve(ROOT, path), "utf8")

// The Action and the GitLab template install the npm package, so each release must pin itself.
describe("the release's pinned version", () => {
  it("is the same in package.json, the Action and the GitLab template", async () => {
    const version = /"version": "([^"]+)"/.exec(await read("package.json"))?.[1]
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(await read("action.yml")).toContain(`default: "walkdiff@${version}"`)
    const gitlab = await read("ci/gitlab-ci.yml")
    expect(gitlab).toContain(`WALKDIFF_PACKAGE: "walkdiff@${version}"`)
    expect(gitlab).toContain(`/v${version}/ci/gitlab-ci.yml`)
  })
})
