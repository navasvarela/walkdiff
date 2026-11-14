import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { releaseNotes, ReleaseNotesError } from "./releaseNotes.ts"

/**
 * Moves every pinned mention of the current version to the next one, for the release PR. If the
 * changelog has no section for the new version yet, lists the PRs merged since the last tag, which
 * that section is written from.
 *
 * Usage: node scripts/prepareRelease.ts 0.10.1
 */
const ROOT = resolve(import.meta.dirname, "..")
const MANIFEST = "package.json"
// Each file points people at the released version: the Action's tag, the npm package, or both.
const PINNED_FILES: readonly string[] = ["README.md", "action.yml", "ci/gitlab-ci.yml", "docs/pilot.md", "site/manual.html"]
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const MANIFEST_VERSION = /"version": "([^"]+)"/

export class ReleasePreparationError extends Error {}

/** The version parts, or undefined when the text isn't a plain `major.minor.patch` version. */
function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = VERSION.exec(text)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * # Errors
 *
 * Throws a `ReleasePreparationError` when `next` isn't a `major.minor.patch` version above `current`.
 */
export function checkNextVersion(current: string, next: string): void {
  const from = parseVersion(current)
  const to = parseVersion(next)
  if (to === undefined) throw new ReleasePreparationError(`"${next}" isn't a version such as 1.2.3.`)
  if (from === undefined) throw new ReleasePreparationError(`package.json's version "${current}" isn't a version such as 1.2.3.`)
  const isHigher = to[0] !== from[0] ? to[0] > from[0] : to[1] !== from[1] ? to[1] > from[1] : to[2] > from[2]
  if (!isHigher) throw new ReleasePreparationError(`${next} isn't above the current version, ${current}.`)
}

/**
 * Replaces `v<from>` (a tag) and `walkdiff@<from>` (the npm package). A version is only replaced
 * whole, so moving 0.1.0 leaves 0.1.0.1 and 10.1.0 alone.
 */
export function bumpPins(text: string, from: string, to: string): string {
  const escaped = from.replaceAll(".", "\\.")
  return text.replace(new RegExp(`(?<![\\w.])(v|walkdiff@)${escaped}(?![\\w.]*\\d)`, "g"), `$1${to}`)
}

async function mergedSince(tag: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)("git", ["log", `${tag}..HEAD`, "--format=%s"], { cwd: ROOT, encoding: "utf8" })
  return stdout.split("\n").filter((line) => line !== "")
}

async function main(next: string | undefined): Promise<void> {
  if (next === undefined) throw new ReleasePreparationError("Usage: node scripts/prepareRelease.ts <version>")
  const manifest = await readFile(resolve(ROOT, MANIFEST), "utf8")
  const current = MANIFEST_VERSION.exec(manifest)?.[1]
  if (current === undefined) throw new ReleasePreparationError("package.json has no version.")
  checkNextVersion(current, next)

  // Every file is checked before any is written, so a stale pin doesn't leave a half-bumped tree.
  const files = await Promise.all(PINNED_FILES.map(async (path) => ({ path, text: await readFile(resolve(ROOT, path), "utf8") })))
  const bumped = files.map((file) => ({ ...file, bumped: bumpPins(file.text, current, next) }))
  const stale = bumped.filter((file) => file.bumped === file.text).map((file) => file.path)
  if (stale.length > 0) throw new ReleasePreparationError(`No pin of ${current} to move in ${stale.join(", ")}. Check they still point at releases.`)
  await writeFile(resolve(ROOT, MANIFEST), manifest.replace(MANIFEST_VERSION, `"version": "${next}"`))
  await Promise.all(bumped.map((file) => writeFile(resolve(ROOT, file.path), file.bumped)))
  console.log(`Moved ${current} to ${next} in ${[MANIFEST, ...PINNED_FILES].join(", ")}.`)

  try {
    releaseNotes(await readFile(resolve(ROOT, "CHANGELOG.md"), "utf8"), next)
  } catch (error: unknown) {
    if (!(error instanceof ReleaseNotesError)) throw error
    console.log(`\nCHANGELOG.md needs a "## ${next}" section. Merged since v${current}:`)
    for (const subject of await mergedSince(`v${current}`)) console.log(`  - ${subject}`)
  }
}

if (import.meta.main) {
  main(process.argv.at(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
