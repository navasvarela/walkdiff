import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { AnalysisStep, REVIEW_MODEL_SCHEMA_VERSION, stepLabel } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { PLUGIN_API_VERSION } from "./appServer.ts"

// The Neovim plugin is Lua, so it can't import the app's constants; it keeps copies. These tests
// fail when the app moves on without it.
const NVIM_LUA = join(import.meta.dirname, "..", "..", "..", "nvim", "lua", "walkdiff")

async function luaSource(file: string): Promise<string> {
  return readFile(join(NVIM_LUA, file), "utf8")
}

function luaNumber(source: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name} = (\\d+)`).exec(source)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

describe("the Neovim plugin", () => {
  it("reads the API and report versions the app speaks", async () => {
    const versions = await luaSource("versions.lua")
    expect({ api: luaNumber(versions, "api"), report: luaNumber(versions, "report_schema") }).toEqual({ api: PLUGIN_API_VERSION, report: REVIEW_MODEL_SCHEMA_VERSION })
  })

  it("knows every analysis step, in order, with the app's labels", async () => {
    const rows = await luaSource("rows.lua")
    const steps = [...rows.matchAll(/\{ id = "(\w+)", label = "([^"]+)" \}/g)].map(([, id, label]) => [id, label])
    expect(steps).toEqual(Object.values(AnalysisStep).map((step) => [step, stepLabel(step)]))
  })
})
