/** OSV's names for the package ecosystems the engine reads. */
export const Ecosystem = { Npm: "npm", Crates: "crates.io", PyPI: "PyPI", Go: "Go", Maven: "Maven" } as const
export type Ecosystem = (typeof Ecosystem)[keyof typeof Ecosystem]

export interface PackageVersion {
  readonly ecosystem: Ecosystem
  readonly name: string
  readonly version: string
}

/** What a manifest asks for: package name → version requirement as written. */
export type DeclaredDependencies = ReadonlyMap<string, string>
