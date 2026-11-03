import { existsSync } from "node:fs"

/**
 * The first of several places a file can be. Walkdiff runs from source in this repository, and from
 * one bundled file in the npm package, so the same file sits in a different place relative to the
 * code that needs it. Falls back to the last candidate, the source location, so an error names a
 * path a developer can act on.
 */
export function firstExisting(candidates: readonly string[], exists: (path: string) => boolean = existsSync): string {
  return candidates.find((path) => exists(path)) ?? candidates.at(-1) ?? ""
}
