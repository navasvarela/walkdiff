import { rmSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * How editor plugins find a running app: its address and the key its API requires, in a file
 * only the user can read. The key is otherwise created fresh each run and never stored, so this
 * file is the one place it's written down; it's removed when the app stops. A file left by an app
 * that crashed points at nothing, which a plugin finds out from `GET /api/info`.
 */
export const CONNECTION_FILE = "app.json"
// Read and write for the user only: anyone else who could read the key could act with their token.
const OWNER_ONLY = 0o600

export interface AppConnection {
  readonly url: string
  readonly apiKey: string
  /** The plugin API's version; see docs/app-api.md. */
  readonly apiVersion: number
  readonly version: string
  readonly pid: number
}

export async function writeConnectionFile(dataDir: string, connection: AppConnection): Promise<string> {
  const path = join(dataDir, CONNECTION_FILE)
  // Removed first, as a mode only applies to a file being created.
  await rm(path, { force: true })
  await writeFile(path, `${JSON.stringify(connection, null, 2)}\n`, { mode: OWNER_ONLY })
  return path
}

/** Removes the file when the process ends, including on Ctrl+C, which would otherwise skip `exit`. */
export function removeOnExit(path: string): void {
  const remove = (): void => rmSync(path, { force: true })
  process.once("exit", remove)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      remove()
      process.exit(signal === "SIGINT" ? EXIT_ON_SIGINT : EXIT_ON_SIGTERM)
    })
  }
}

// The shell's convention: 128 plus the signal's number.
const EXIT_ON_SIGINT = 130
const EXIT_ON_SIGTERM = 143
