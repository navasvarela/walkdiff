import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ConnectionFileError, connectionFilePath, readConnection } from "./connection.ts"

const CONNECTION = { url: "http://127.0.0.1:4317/", apiKey: "k", apiVersion: 1, version: "0.14.0", pid: 42 }

describe("connectionFilePath", () => {
  it.each([
    ["", {}, "/home/me/.local/share/walkdiff/app.json"],
    ["", { XDG_DATA_HOME: "/data" }, "/data/walkdiff/app.json"],
    ["  /custom  ", { XDG_DATA_HOME: "/data" }, "/custom/app.json"],
  ])("finds the file for setting %j and %j", (setting, env, expected) => {
    expect(connectionFilePath(setting, env, "/home/me")).toBe(expected)
  })
})

describe("readConnection", () => {
  let dir = ""
  const write = async (name: string, content: unknown): Promise<string> => {
    const path = join(dir, name)
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content))
    return path
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-vscode-"))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads the app's address and key", async () => {
    expect(await readConnection(await write("good.json", CONNECTION))).toEqual(CONNECTION)
  })

  it("says the app isn't running when there's no file", async () => {
    expect(await readConnection(join(dir, "missing.json"))).toBeUndefined()
  })

  it.each([
    ["not JSON", "{"],
    ["an address off this machine", { ...CONNECTION, url: "http://example.com:4317/" }],
    ["https, which the app never serves", { ...CONNECTION, url: "https://127.0.0.1:4317/" }],
    ["no key", { ...CONNECTION, apiKey: "" }],
  ])("refuses a file with %s", async (_case, content) => {
    await expect(readConnection(await write("bad.json", content))).rejects.toThrow(ConnectionFileError)
  })
})
