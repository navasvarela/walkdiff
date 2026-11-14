import type { Ecosystem } from "../dependencies/ecosystem.ts"
import type { PackageOrigin } from "./packageOrigin.ts"

/** One package version a lockfile pins, with what the supply-chain rules compare between commits. */
export interface LockedPackage {
  readonly name: string
  readonly version: string
  readonly origin: PackageOrigin
  /**
   * Content hashes keyed by what they cover and their algorithm, such as `sha512` for an npm
   * tarball or `anyio-4.4.0.tar.gz sha256` for one file of a Python release. Keying by algorithm
   * keeps a lockfile that moves from sha1 to sha512 from looking like changed content.
   */
  readonly hashes: ReadonlyMap<string, string>
  /** Whether installing it runs its own scripts; false where the lockfile doesn't record it. */
  readonly runsInstallScript: boolean
  /** Text that first appears in the lockfile on this package's entry, to link a finding to it. */
  readonly anchor: string
}

export interface LockfileReader {
  readonly ecosystem: Ecosystem
  matches(fileName: string): boolean
  /** Throws when the text isn't a lockfile of this format. */
  read(text: string): LockedPackage[]
}

/** The line where `anchor` first appears, to link a finding to a package's entry. */
export function lineOfAnchor(text: string, anchor: string): number | null {
  const index = text.indexOf(anchor)
  if (index === -1) return null
  let line = 1
  for (let position = text.indexOf("\n"); position !== -1 && position < index; position = text.indexOf("\n", position + 1)) line++
  return line
}

/** `sha512-abc sha1-def` → sha512 → sha512-abc, sha1 → sha1-def. */
export function hashesByAlgorithm(hashes: string, prefix = ""): ReadonlyMap<string, string> {
  return new Map(
    hashes
      .split(/\s+/)
      .filter((hash) => hash !== "")
      .map((hash) => [`${prefix}${hash.split(/[-:]/)[0] ?? ""}`, hash]),
  )
}
