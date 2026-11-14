/** Where a locked package is downloaded from, as far as its lockfile says. */
export const OriginKind = { Registry: "registry", Git: "git", Url: "url", Local: "local" } as const
export type OriginKind = (typeof OriginKind)[keyof typeof OriginKind]

export type PackageOrigin =
  | { readonly kind: typeof OriginKind.Registry; readonly registry: string; readonly secure: boolean }
  | { readonly kind: typeof OriginKind.Git; readonly repository: string; readonly secure: boolean }
  | { readonly kind: typeof OriginKind.Url; readonly url: string; readonly secure: boolean }
  | { readonly kind: typeof OriginKind.Local }

export const PublicRegistry = { Npm: "registry.npmjs.org", PyPI: "pypi.org", Crates: "crates.io" } as const
export type PublicRegistry = (typeof PublicRegistry)[keyof typeof PublicRegistry]

// Hosts that serve the same public registry, so moving between them isn't a change of source.
// Yarn's registry is a mirror of npm's, PyPI serves files from its own CDN, and crates.io has a git
// index and a sparse one.
const REGISTRY_ALIASES: ReadonlyMap<string, PublicRegistry> = new Map([
  ["registry.npmjs.org", PublicRegistry.Npm],
  ["registry.npmjs.com", PublicRegistry.Npm],
  ["registry.yarnpkg.com", PublicRegistry.Npm],
  ["pypi.org", PublicRegistry.PyPI],
  ["pypi.python.org", PublicRegistry.PyPI],
  ["files.pythonhosted.org", PublicRegistry.PyPI],
  ["index.crates.io", PublicRegistry.Crates],
  ["github.com/rust-lang/crates.io-index", PublicRegistry.Crates],
])
const PUBLIC_REGISTRIES: ReadonlySet<string> = new Set(Object.values(PublicRegistry))

/**
 * pnpm and Yarn 2+ record a package from the registry without naming the registry, which comes from
 * the project's settings. Comparing two entries with this name still works; asking whether it's a
 * public registry can't.
 */
export const CONFIGURED_REGISTRY = "the configured registry"

// npm-compatible registries serve a version's tarball at `<name>/-/<file>.tgz`.
const REGISTRY_TARBALL = /\/-\/[^/]+\.tgz$/
const GIT_REFERENCE = /^(?:git\+|git:|git@|ssh:|github:|gitlab:|bitbucket:)/
const INSECURE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "git:"])

export function registryOrigin(url: string): PackageOrigin {
  const parsed = URL.parse(url)
  if (parsed === null) return { kind: OriginKind.Registry, registry: url, secure: true }
  return { kind: OriginKind.Registry, registry: registryNameOf(parsed), secure: !INSECURE_PROTOCOLS.has(parsed.protocol) }
}

export function gitOrigin(reference: string): PackageOrigin {
  const repository = reference.replace(/^git\+/, "").replace(/[#?].*$/, "")
  return { kind: OriginKind.Git, repository, secure: !/^(?:git|http):/.test(repository) }
}

/** Reads a download URL as written in npm-family lockfiles: a registry tarball, a git repository or any other URL. */
export function downloadOrigin(reference: string): PackageOrigin {
  if (GIT_REFERENCE.test(reference)) return gitOrigin(reference)
  const parsed = URL.parse(reference)
  if (parsed === null || parsed.protocol === "file:") return { kind: OriginKind.Local }
  if (REGISTRY_TARBALL.test(parsed.pathname)) return registryOrigin(parsed.origin)
  return { kind: OriginKind.Url, url: `${parsed.origin}${parsed.pathname}`, secure: !INSECURE_PROTOCOLS.has(parsed.protocol) }
}

// crates.io's git index lives on github.com, so its path is part of the name.
function registryNameOf(url: URL): string {
  const withPath = `${url.host}${url.pathname.replace(/(?:\.git)?\/?$/, "")}`
  return REGISTRY_ALIASES.get(withPath) ?? REGISTRY_ALIASES.get(url.host) ?? url.host
}

/** Two origins with the same key serve the same package: a git repository at any commit, or a URL's host. */
export function originKey(origin: PackageOrigin): string {
  switch (origin.kind) {
    case OriginKind.Registry:
      return `registry:${origin.registry}`
    case OriginKind.Git:
      return `git:${origin.repository}`
    case OriginKind.Url:
      return `url:${URL.parse(origin.url)?.host ?? origin.url}`
    case OriginKind.Local:
      return "local"
  }
}

export function describeOrigin(origin: PackageOrigin): string {
  switch (origin.kind) {
    case OriginKind.Registry:
      return origin.registry
    case OriginKind.Git:
      return origin.repository
    case OriginKind.Url:
      return origin.url
    case OriginKind.Local:
      return "a local path"
  }
}

export function isPublicRegistry(origin: PackageOrigin): boolean {
  return origin.kind === OriginKind.Registry && PUBLIC_REGISTRIES.has(origin.registry)
}

export function isInsecure(origin: PackageOrigin): boolean {
  return origin.kind !== OriginKind.Local && !origin.secure
}
