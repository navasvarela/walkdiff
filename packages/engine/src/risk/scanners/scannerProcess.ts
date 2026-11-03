import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a scanner; undefined means its binary is not installed. Injected so tests need no scanners. */
export type ScannerProcessRunner = (binary: string, args: readonly string[], cwd: string) => Promise<ProcessResult | undefined>

// Semgrep's first run downloads rules, and large PRs take a while; past this, report it as not run.
const SCANNER_TIMEOUT_MS = 5 * 60 * 1000
const MAX_SCANNER_OUTPUT_BYTES = 256 * 1024 * 1024
// A scanner reads untrusted code and has no need for the user's tokens, so it gets only these.
const INHERITED_VARIABLES: readonly string[] = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE"]

/**
 * Where Walkdiff keeps the scanners it installs, in the person's cache folder. It's outside the code
 * so an npm package, which `npx` may remove at any time, doesn't lose them. See `installScanners`.
 */
export function scannersRootFor(env: Readonly<Record<string, string | undefined>>): string {
  const xdgCache = env.XDG_CACHE_HOME?.trim()
  return join(xdgCache === undefined || xdgCache === "" ? join(homedir(), ".cache") : xdgCache, "walkdiff", "scanners")
}

export const MANAGED_SCANNERS_ROOT = scannersRootFor(process.env)

/**
 * The scanners that come with Walkdiff, then the npm packages it depends on, such as oxlint and
 * jscpd. They come first so everyone runs the pinned versions, whatever else is on their PATH. Any
 * other scanner is looked up on the PATH, and Windows falls back to the PATH too, as `execFile`
 * can't run the `.cmd` wrappers npm writes there. Those packages' `.bin` folder is in one of three
 * places: this repository's engine package, or for the npm package, its own folder or the shared
 * one npm hoists dependencies into.
 */
const BUNDLED_BINARY_DIRS: readonly string[] = [
  join(MANAGED_SCANNERS_ROOT, "bin"),
  resolve(import.meta.dirname, "../../../node_modules/.bin"),
  resolve(import.meta.dirname, "node_modules/.bin"),
  resolve(import.meta.dirname, "../.bin"),
]

export function scannerExecutable(binary: string, isFile: (path: string) => boolean = existsSync, directories: readonly string[] = BUNDLED_BINARY_DIRS): string {
  return directories.map((directory) => join(directory, binary)).find((path) => isFile(path)) ?? binary
}

export const runScannerProcess: ScannerProcessRunner = (binary, args, cwd) =>
  new Promise((resolve) => {
    const env: Record<string, string> = { SEMGREP_SEND_METRICS: "off" }
    for (const name of INHERITED_VARIABLES) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    execFile(scannerExecutable(binary), [...args], { cwd, env, timeout: SCANNER_TIMEOUT_MS, maxBuffer: MAX_SCANNER_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr })
        return
      }
      if (error.code === "ENOENT") {
        resolve(undefined)
        return
      }
      // A timeout or signal has no numeric code; -1 lands in each scanner's failure path.
      resolve({ exitCode: typeof error.code === "number" ? error.code : -1, stdout, stderr: stderr || error.message })
    })
  })

/** The first line of a scanner's error output, for showing why it did not run. */
export function firstErrorLine(result: ProcessResult): string {
  return result.stderr.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 200) ?? `exit code ${result.exitCode}`
}
