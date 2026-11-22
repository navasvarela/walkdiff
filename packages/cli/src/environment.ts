import { execFile } from "node:child_process"
import { chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { isTrustedHost, TRUSTED_GITHUB_HOSTS_VARIABLE, TRUSTED_GITLAB_HOSTS_VARIABLE } from "@walkdiff/providers"
import type { HostTokens, RepositoryRef } from "@walkdiff/providers"
import { GitHostKind } from "@walkdiff/review-model"
import { UsageError } from "./args.ts"

type Environment = Readonly<Record<string, string | undefined>>

export function readHostTokens(env: Environment): HostTokens {
  return {
    github: nonEmpty(env.GITHUB_TOKEN) ?? nonEmpty(env.GH_TOKEN),
    gitlab: nonEmpty(env.GITLAB_TOKEN),
    trustedOrigins: {
      github: [...parseTrustedHosts(env[TRUSTED_GITHUB_HOSTS_VARIABLE]), ...ciServerOrigin(env.GITHUB_ACTIONS, env.GITHUB_SERVER_URL)],
      gitlab: [...parseTrustedHosts(env[TRUSTED_GITLAB_HOSTS_VARIABLE]), ...ciServerOrigin(env.GITLAB_CI, env.CI_SERVER_URL)],
    },
  }
}

/**
 * Comma-separated hosts, such as `git.acme.internal`. These come from the environment and
 * not `.walkdiff.json`, because that file belongs to the repository the token would be sent to.
 * A bare host means https; plain http has to be spelled out.
 */
function parseTrustedHosts(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const url = entry.includes("://") ? entry : `https://${entry}`
      if (!URL.canParse(url)) throw new UsageError(`Not a host name in a trusted hosts variable: "${entry}"`)
      return new URL(url).origin
    })
}

/** A CI job runs on its own server, so GitHub Enterprise and self-managed GitLab need no setup. */
function ciServerOrigin(isCi: string | undefined, serverUrl: string | undefined): string[] {
  return isCi === "true" && serverUrl !== undefined && URL.canParse(serverUrl) ? [new URL(serverUrl).origin] : []
}

/** Runs a command and gives its output, or undefined if it is missing or fails. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string | undefined>

const CREDENTIAL_COMMAND_TIMEOUT_MS = 5_000
const OWNER_ONLY_DIR_MODE = 0o700

export const runCommand: CommandRunner = async (command, args) => {
  try {
    const { stdout } = await promisify(execFile)(command, [...args], { timeout: CREDENTIAL_COMMAND_TIMEOUT_MS })
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Tokens for one host: the environment first, then the GitHub CLI's login, so engineers
 * already signed in need no setup. `gh` is only asked about trusted hosts because it answers
 * for any host other than github.com when `GH_ENTERPRISE_TOKEN` is set, which would hand that
 * token to whatever link was pasted. No such lookup is used for GitLab: only the variable is read.
 */
export async function hostTokensFor(ref: RepositoryRef, env: Environment, run: CommandRunner): Promise<HostTokens> {
  const tokens = readHostTokens(env)
  if (ref.host !== GitHostKind.GitHub || tokens.github !== undefined || !isTrustedHost(ref, tokens.trustedOrigins)) return tokens
  const output = await run("gh", ["auth", "token", "--hostname", new URL(ref.webOrigin).host])
  return { ...tokens, github: nonEmpty(output?.trim()) }
}

/**
 * Closes the default folders to other users of this machine. The umask only covers new
 * files; earlier versions created these folders readable by everyone. Closing the top folder
 * protects everything inside. Folders chosen with `--cache-dir` or `--out` are left alone,
 * as they may be shared on purpose.
 */
export async function protectLocalData(env: Environment): Promise<void> {
  await Promise.all([defaultCacheDir(env), defaultDataDir(env)].map((dir) => chmodIfPresent(dir, OWNER_ONLY_DIR_MODE)))
}

async function chmodIfPresent(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
}

export function defaultDataDir(env: Environment): string {
  const xdgData = nonEmpty(env.XDG_DATA_HOME)
  return join(xdgData ?? join(homedir(), ".local", "share"), "walkdiff")
}

export function defaultCacheDir(env: Environment): string {
  const xdgCache = nonEmpty(env.XDG_CACHE_HOME)
  return join(xdgCache ?? join(homedir(), ".cache"), "walkdiff")
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value
}
