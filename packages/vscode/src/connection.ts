import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

/** The file a running app writes, described in docs/app-api.md. */
export const CONNECTION_FILE = "app.json"

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * The app only listens on loopback. Refusing any other address keeps the key, and whatever the
 * extension sends, on this machine even if something else wrote the file.
 */
function isLoopback(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname)
}

const appConnectionSchema = z.object({
  url: z.url({ protocol: /^http$/ }).refine(isLoopback, "The app should be on this machine"),
  apiKey: z.string().min(1),
  apiVersion: z.number().int(),
  version: z.string(),
  pid: z.number().int(),
})
export type AppConnection = z.infer<typeof appConnectionSchema>

export class ConnectionFileError extends Error {
  override readonly name = "ConnectionFileError"
}

type Environment = Readonly<Record<string, string | undefined>>

/** Where the app writes its connection file, matching the app's own default data directory. */
export function connectionFilePath(dataDirSetting: string, env: Environment, home: string = homedir()): string {
  const dataDir = dataDirSetting.trim() !== "" ? dataDirSetting.trim() : join(nonEmpty(env.XDG_DATA_HOME) ?? join(home, ".local", "share"), "walkdiff")
  return join(dataDir, CONNECTION_FILE)
}

/**
 * The running app's address and key; undefined when the app isn't running.
 *
 * # Errors
 *
 * Throws a `ConnectionFileError` when the file is there but isn't one the app wrote.
 */
export async function readConnection(path: string): Promise<AppConnection | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  const parsed = appConnectionSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new ConnectionFileError(`${path} isn't a Walkdiff app connection file.`)
  return parsed.data
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value
}
