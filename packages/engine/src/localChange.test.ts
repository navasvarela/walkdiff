import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runGit } from "./git.ts"
import { LocalChangeError, readLocalChange } from "./localChange.ts"

// Commits are made without the machine's own config, which may sign them or set hooks.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
}

describe("readLocalChange", () => {
  let repoDir = ""
  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: GIT_ENV }).then((output) => output.trim())
  const commit = async (path: string, text: string, message: string): Promise<void> => {
    await writeFile(join(repoDir, path), text)
    await git("add", path)
    await git("commit", "--quiet", "--message", message)
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-local-"))
    await git("init", "--quiet", "--initial-branch", "main")
    await commit("a.py", "def a():\n    return 1\n", "start")
    await git("checkout", "--quiet", "-b", "feature/parser")
    await commit("a.py", "def a():\n    return 2\n", "Return two")
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("reads one commit on a branch, titled by its message, against main", async () => {
    const { change, uncommittedFiles, repoDir: top } = await readLocalChange({ cwd: repoDir, baseRef: undefined })
    expect(change).toMatchObject({ host: "local", repositoryName: basename(repoDir), title: "Return two", author: "Ada", baseRef: "main", headRef: "feature/parser" })
    expect(change.mergeBaseSha).toBe(await git("rev-parse", "main"))
    expect(change.headSha).toBe(await git("rev-parse", "HEAD"))
    expect(uncommittedFiles).toBe(0)
    expect(top.endsWith(basename(repoDir))).toBe(true)
  })

  it("titles several commits by the branch, lists them, and counts uncommitted files it leaves out", async () => {
    await commit("b.py", "def b():\n    pass\n", "Add b")
    await writeFile(join(repoDir, "a.py"), "def a():\n    return 3\n")
    const { change, uncommittedFiles } = await readLocalChange({ cwd: repoDir, baseRef: "main" })
    expect(change.title).toBe("feature/parser")
    expect(change.description).toBe("- Add b\n- Return two")
    expect(uncommittedFiles).toBe(1)
    await git("checkout", "--quiet", "--", "a.py")
  })

  it.each([
    ["a base that doesn't exist", { baseRef: "nope" }, "nope isn't a commit"],
    ["a branch with nothing of its own", { baseRef: "feature/parser" }, "has no commits that aren't on feature/parser"],
  ])("explains %s", async (_case, request, message) => {
    const attempt = readLocalChange({ cwd: repoDir, ...request })
    await expect(attempt).rejects.toThrow(LocalChangeError)
    await expect(readLocalChange({ cwd: repoDir, ...request })).rejects.toThrow(message)
  })

  it("explains when it isn't run in a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "walkdiff-not-a-repo-"))
    await expect(readLocalChange({ cwd: outside, baseRef: undefined })).rejects.toThrow("isn't inside a git repository")
    await rm(outside, { recursive: true, force: true })
  })
})
