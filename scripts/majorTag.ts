/**
 * Prints the moving tag a release should move, such as `v0` for `v0.13.0`, so the GitHub Action's
 * users can pin `navasvarela/walkdiff@v0` and get each release of that major version. Prints
 * nothing when a newer release of that major exists, so re-running an old release never moves the
 * tag back. The Release workflow runs it once the release is published.
 *
 * Usage: node scripts/majorTag.ts v0.13.0 <every existing tag…>
 */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

type Version = readonly [number, number, number]

export class MajorTagError extends Error {}

function parseTag(tag: string): Version | undefined {
  const match = RELEASE_TAG.exec(tag)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isNewer(a: Version, b: Version): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
}

/**
 * The moving tag for `tag`, or undefined when `existing` has a newer release of the same major.
 * Tags that aren't releases, such as `v0` itself, are ignored.
 *
 * # Errors
 *
 * Throws a `MajorTagError` when `tag` isn't a release tag such as `v1.2.3`.
 */
export function majorTagToMove(tag: string, existing: readonly string[]): string | undefined {
  const release = parseTag(tag)
  if (release === undefined) throw new MajorTagError(`"${tag}" isn't a release tag such as v1.2.3.`)
  const newer = existing.some((other) => {
    const version = parseTag(other)
    return version !== undefined && version[0] === release[0] && isNewer(version, release)
  })
  return newer ? undefined : `v${release[0]}`
}

if (import.meta.main) {
  const [tag, ...existing] = process.argv.slice(2)
  try {
    const major = majorTagToMove(tag ?? "", existing)
    if (major !== undefined) process.stdout.write(`${major}\n`)
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
