import { execFileSync } from "node:child_process"
import { copyFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

/**
 * Builds the extension and packages it as a .vsix, the file both the VS Code Marketplace and Open VSX
 * take. The bundle holds every dependency, so vsce is told not to look for any: it can't read a
 * pnpm workspace's. The repository's licence is copied in for the package and removed after.
 *
 *   pnpm --filter walkdiff-vscode package
 */
const ROOT = import.meta.dirname
const LICENSE = join(ROOT, "LICENSE.md")
const REPOSITORY_FOLDER = "https://github.com/navasvarela/walkdiff"

const manifest: unknown = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"))
const version = typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string" ? manifest.version : undefined
if (version === undefined) throw new Error("packages/vscode/package.json has no version")
const out = `walkdiff-vscode-${version}.vsix`

execFileSync("node", ["build.ts"], { cwd: ROOT, stdio: "inherit" })
await copyFile(join(ROOT, "..", "..", "LICENSE.md"), LICENSE)
try {
  // The README's images and links are relative to this folder, which vsce would otherwise take as
  // the repository's root; the registries show them from GitHub, so they stay out of the package.
  execFileSync(join(ROOT, "node_modules", ".bin", "vsce"), ["package", "--no-dependencies", "--baseContentUrl", `${REPOSITORY_FOLDER}/blob/HEAD/packages/vscode`, "--baseImagesUrl", `${REPOSITORY_FOLDER}/raw/HEAD/packages/vscode`, "--out", out], { cwd: ROOT, stdio: "inherit" })
} finally {
  await rm(LICENSE, { force: true })
}
console.log(`Packaged ${join(ROOT, out)}`)
