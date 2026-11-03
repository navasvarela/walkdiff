import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "rolldown"

/**
 * Builds the npm package in `dist-package/`: Walkdiff's own workspace packages bundled into one
 * file, with the built report and app pages and Semgrep's lock file beside it. Third-party
 * libraries stay ordinary dependencies, so people can audit them, and so the parsers' grammar
 * files resolve from node_modules as they do from source.
 */
const ROOT = resolve(import.meta.dirname, "..")
const OUT = join(ROOT, "dist-package")
const BUNDLE = "walkdiff.mjs"
// The workspace packages that run in Node; the UI packages are built into their own pages.
const RUNTIME_PACKAGES = ["cli", "engine", "providers", "review-model"]
const WORKSPACE_PREFIX = "workspace:"

interface Manifest {
  readonly version?: string
  readonly license?: string
  readonly engines?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
}

async function manifest(path: string): Promise<Manifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  return typeof parsed === "object" && parsed !== null ? parsed : {}
}

async function thirdPartyDependencies(): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {}
  for (const name of RUNTIME_PACKAGES) {
    const { dependencies: declared = {} } = await manifest(join(ROOT, "packages", name, "package.json"))
    for (const [dependency, version] of Object.entries(declared)) {
      if (version.startsWith(WORKSPACE_PREFIX)) continue
      const existing = dependencies[dependency]
      if (existing !== undefined && existing !== version) throw new Error(`${dependency} is declared as both ${existing} and ${version}`)
      dependencies[dependency] = version
    }
  }
  return dependencies
}

const root = await manifest(join(ROOT, "package.json"))
const dependencies = await thirdPartyDependencies()
const external = (id: string): boolean => id.startsWith("node:") || Object.keys(dependencies).some((name) => id === name || id.startsWith(`${name}/`))

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
await build({ input: join(ROOT, "packages/cli/src/main.ts"), platform: "node", external, output: { file: join(OUT, BUNDLE), format: "esm" } })
await cp(join(ROOT, "packages/report-ui/dist"), join(OUT, "report-ui"), { recursive: true })
await cp(join(ROOT, "packages/app-ui/dist"), join(OUT, "app-ui"), { recursive: true })
await cp(join(ROOT, "packages/engine/scanner-pins"), join(OUT, "scanner-pins"), { recursive: true })
for (const file of ["README.md", "LICENSE.md", "CHANGELOG.md", "SECURITY.md"]) await cp(join(ROOT, file), join(OUT, file))

const packageJson = {
  name: "walkdiff",
  version: root.version,
  description: "A review companion for GitHub pull requests and GitLab merge requests",
  license: root.license,
  type: "module",
  bin: { walkdiff: BUNDLE },
  engines: root.engines,
  // npm checks this against the repository that published it, for provenance.
  repository: { type: "git", url: "git+https://github.com/navasvarela/walkdiff.git" },
  homepage: "https://github.com/navasvarela/walkdiff",
  files: [BUNDLE, "report-ui", "app-ui", "scanner-pins", "SECURITY.md", "CHANGELOG.md"],
  dependencies,
}
await writeFile(join(OUT, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`)
console.log(`Built walkdiff ${root.version ?? "?"} in ${OUT}`)
