import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

/**
 * Prints the GitHub release notes for a tag: that version's changelog section, then how the
 * package was built and where to read more. The Release workflow runs it before publishing, so a
 * tag whose version has no changelog section stops before anything reaches npm.
 *
 * Usage: node scripts/releaseNotes.ts v0.8.0
 */
const VERSION_HEADING = /^## (\S+)\s*$/
const TAG_PREFIX = "v"

// GitHub resolves relative links in a release's notes against its tag.
const FOOTER = [
  "Built and published by the Release workflow after a manual approval, with an npm provenance statement linking it to this commit. Check it with `npm audit signatures`.",
  "See [CHANGELOG.md](CHANGELOG.md) for everything. This is still early software, and it has not had an independent security audit. See [SECURITY.md](SECURITY.md).",
].join("\n\n")

export class ReleaseNotesError extends Error {}

/**
 * # Errors
 *
 * Throws a `ReleaseNotesError` when the changelog has no section for `version`, or the section is
 * empty.
 */
export function releaseNotes(changelog: string, tag: string): string {
  const version = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag
  const section = changelogSection(changelog, version)
  if (section === undefined) throw new ReleaseNotesError(`CHANGELOG.md has no "## ${version}" section. Add it in the release PR before tagging.`)
  if (section === "") throw new ReleaseNotesError(`CHANGELOG.md's "## ${version}" section is empty.`)
  return [section, FOOTER].join("\n\n")
}

function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n")
  const start = lines.findIndex((line) => line.match(VERSION_HEADING)?.at(1) === version)
  if (start === -1) return undefined
  const next = lines.findIndex((line, index) => index > start && VERSION_HEADING.test(line))
  return lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim()
}

async function main(tag: string | undefined): Promise<void> {
  if (tag === undefined) throw new ReleaseNotesError("Usage: node scripts/releaseNotes.ts <tag>")
  const changelog = await readFile(resolve(import.meta.dirname, "../CHANGELOG.md"), "utf8")
  process.stdout.write(`${releaseNotes(changelog, tag)}\n`)
}

if (import.meta.main) {
  main(process.argv.at(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
