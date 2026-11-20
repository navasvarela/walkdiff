import { HistoryUnavailableError } from "@walkdiff/review-model"
import type { FileCommit, FileHistory, FileHistoryReader } from "@walkdiff/review-model"
import { ISOLATED_CONFIG_ENV, runGit } from "../../git.ts"

// Separators git never puts in a commit's subject, author or date, nor in a path it prints.
const RECORD = "\x1e"
const FIELD = "\x1f"
const LOG_FORMAT = `${RECORD}%H${FIELD}%s${FIELD}%ae${FIELD}%cI`
// Keeps each command line well under the operating system's limit, whatever the paths' lengths.
const PATHS_PER_COMMAND = 200

/**
 * Reads file history from the repository itself, for local reviews and checkouts with history.
 * A shallow repository, such as the depth-1 cache a hosted review fetches, has none to give.
 */
export function gitHistoryReader(repoDir: string): FileHistoryReader {
  return async ({ paths, until, since }) => {
    const shallow = (await runGit(["rev-parse", "--is-shallow-repository"], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })).trim() === "true"
    if (shallow) throw new HistoryUnavailableError("the repository was fetched without its history")
    const histories = new Map<string, FileCommit[]>(paths.map((path) => [path, []]))
    for (let start = 0; start < paths.length; start += PATHS_PER_COMMAND) {
      const batch = paths.slice(start, start + PATHS_PER_COMMAND)
      const output = await runGit(["log", until, `--since=${since.toISOString()}`, `--format=${LOG_FORMAT}`, "--name-only", "--", ...batch.map((path) => `:(literal)${path}`)], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })
      for (const { commit, paths: touched } of parseLog(output)) {
        for (const path of touched) histories.get(path)?.push(commit)
      }
    }
    return new Map([...histories].map(([path, commits]): [string, FileHistory] => [path, { commits, total: commits.length }]))
  }
}

interface LoggedCommit {
  readonly commit: FileCommit
  readonly paths: readonly string[]
}

function parseLog(output: string): LoggedCommit[] {
  return output
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .flatMap((record) => {
      const [header = "", ...files] = record.split("\n")
      const [sha, subject, author, committedAt] = header.split(FIELD)
      if (sha === undefined || subject === undefined || author === undefined || committedAt === undefined) return []
      return [{ commit: { sha, subject, author, committedAt }, paths: files.filter((file) => file !== "") }]
    })
}
