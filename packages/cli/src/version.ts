import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { firstExisting } from "@walkdiff/engine"
import { z } from "zod"

// The npm package keeps its package.json beside the bundled CLI; from source, the version is the
// repository root's, as packages/cli/package.json is a private workspace at 0.0.0.
const MANIFEST_PATH = firstExisting([resolve(import.meta.dirname, "package.json"), resolve(import.meta.dirname, "../../../package.json")])

const manifestSchema = z.object({ version: z.string().min(1) })

/** The running Walkdiff's version, read from its package.json. */
export function walkdiffVersion(manifestPath: string = MANIFEST_PATH): string {
  return manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8"))).version
}
