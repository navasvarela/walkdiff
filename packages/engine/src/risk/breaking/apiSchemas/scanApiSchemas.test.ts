import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { collectFileDiffs } from "../../../changedFiles.ts"
import { runGit } from "../../../git.ts"
import { classifyNoise } from "../../../noise.ts"
import { scanApiSchemas } from "./scanApiSchemas.ts"
import type { ApiSchemaScan } from "./scanApiSchemas.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

const BASE: Readonly<Record<string, string>> = {
  "schema/query.graphql": "type Query {\n  me: User\n}\n\ntype User {\n  id: ID!\n  email: String\n}\n",
  "proto/billing.proto": 'syntax = "proto3";\npackage billing;\n\nservice Billing {\n  rpc Charge (ChargeRequest) returns (ChargeReply);\n}\n',
  "openapi.yaml": "openapi: 3.0.3\npaths:\n  /health:\n    get:\n      responses:\n        '200': { description: ok }\n",
  "tests/fixtures/old.graphql": "type Fixture { id: ID }\n",
}

// User moves to its own new file and loses a field; billing.proto is deleted; the spec can't be parsed.
const HEAD: Readonly<Record<string, string>> = {
  "schema/query.graphql": "type Query {\n  me: User\n}\n",
  "schema/user.graphql": "type User {\n  id: ID!\n}\n",
  "openapi.yaml": "openapi: 3.0.3\npaths: [unclosed\n",
  "tests/fixtures/old.graphql": "type Other { id: ID }\n",
}

describe("scanApiSchemas", () => {
  let repoDir = ""
  let scan: ApiSchemaScan = { findings: [], notChecked: [] }

  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const commit = async (files: Readonly<Record<string, string>>): Promise<CommitSha> => {
    await git("rm", "-r", "--quiet", "--ignore-unmatch", ".")
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repoDir, path)), { recursive: true })
      await writeFile(join(repoDir, path), text)
    }
    await git("add", "--all")
    await git("commit", "--quiet", "--message", "change")
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-api-schemas-"))
    await git("init", "--quiet")
    const base = await commit(BASE)
    const head = await commit(HEAD)
    const diffs = await collectFileDiffs(repoDir, base, head)
    const files = diffs.map((diff) => ({ diff, noise: classifyNoise(diff.path, HEAD[diff.path]), after: HEAD[diff.path] }))
    scan = await scanApiSchemas(repoDir, base, files)
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("follows a type into a new file, reads a deleted one as removing everything, and skips test fixtures", () => {
    expect(scan.findings.map((finding) => `${finding.ruleId} ${finding.evidence ?? ""} ${finding.location?.path ?? ""}:${finding.location?.line ?? "-"}`)).toEqual([
      "breaking.api-operation-removed billing.Billing.Charge proto/billing.proto:-",
      "breaking.api-field-removed User.email schema/user.graphql:1",
    ])
  })

  it("says which schema it couldn't read", () => {
    expect(scan.notChecked).toEqual([{ check: "OpenAPI breaking changes", reason: expect.stringContaining("couldn't read openapi.yaml: ") }])
  })
})
