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
  matches(fileName: string): boolean
  /** Throws when the text isn't a lockfile of this format. */
  read(text: string): LockedPackage[]
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
