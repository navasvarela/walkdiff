import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { join, relative, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { firstExisting } from "../../locate.ts"
import { downloadWithRetries } from "./downloadWithRetries.ts"
import { MANAGED_SCANNERS_ROOT } from "./scannerProcess.ts"

const ArchiveKind = { TarGz: "tarGz", RawBinary: "rawBinary" } as const
type ArchiveKind = (typeof ArchiveKind)[keyof typeof ArchiveKind]

interface PinnedAsset {
  readonly file: string
  readonly sha256: string
  /** Where the binary sits in the archive, when that isn't at its top level under its own name. */
  readonly member?: string
}

/** A scanner published as one binary per platform. */
export interface BinaryPin {
  readonly binary: string
  readonly version: string
  readonly baseUrl: string
  readonly archive: ArchiveKind
  /** Keyed by `${process.platform}-${process.arch}`. Other platforms fall back to the PATH. */
  readonly assets: Readonly<Record<string, PinnedAsset>>
}

/**
 * Exact versions and their hashes, from each release's published checksums. To update one, change
 * the version and copy the new hashes from that release: a hash that doesn't match stops the
 * install, so a replaced release asset can't reach anyone's machine.
 */
export const BINARY_PINS: readonly BinaryPin[] = [
  {
    binary: "gitleaks",
    version: "8.30.1",
    baseUrl: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1",
    archive: ArchiveKind.TarGz,
    assets: {
      "darwin-arm64": { file: "gitleaks_8.30.1_darwin_arm64.tar.gz", sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" },
      "darwin-x64": { file: "gitleaks_8.30.1_darwin_x64.tar.gz", sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709" },
      "linux-arm64": { file: "gitleaks_8.30.1_linux_arm64.tar.gz", sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" },
      "linux-x64": { file: "gitleaks_8.30.1_linux_x64.tar.gz", sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" },
    },
  },
  {
    binary: "osv-scanner",
    version: "2.7.0",
    baseUrl: "https://github.com/google/osv-scanner/releases/download/v2.7.0",
    archive: ArchiveKind.RawBinary,
    assets: {
      "darwin-arm64": { file: "osv-scanner_darwin_arm64", sha256: "d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b" },
      "darwin-x64": { file: "osv-scanner_darwin_amd64", sha256: "e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45" },
      "linux-arm64": { file: "osv-scanner_linux_arm64", sha256: "4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7" },
      "linux-x64": { file: "osv-scanner_linux_amd64", sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b" },
    },
  },
  {
    binary: "ruff",
    version: "0.17.3",
    baseUrl: "https://github.com/astral-sh/ruff/releases/download/0.17.3",
    archive: ArchiveKind.TarGz,
    assets: {
      "darwin-arm64": { file: "ruff-aarch64-apple-darwin.tar.gz", sha256: "118f7121aa838785672bf612487f755a89108bb5f44e0f3df96c5967a72614f9", member: "ruff-aarch64-apple-darwin/ruff" },
      "darwin-x64": { file: "ruff-x86_64-apple-darwin.tar.gz", sha256: "17f95b1bee24d70de62ffe5beec7f71bb541c7e3d147a1c3d84f7cd6525f6fdf", member: "ruff-x86_64-apple-darwin/ruff" },
      "linux-arm64": { file: "ruff-aarch64-unknown-linux-gnu.tar.gz", sha256: "3f4639152c0e42bb5938e6c23d53d527a38f3133e000102934518f90529fa299", member: "ruff-aarch64-unknown-linux-gnu/ruff" },
      "linux-x64": { file: "ruff-x86_64-unknown-linux-gnu.tar.gz", sha256: "2b0890f5a55900af741f133918c2656919bbf18c2ab7741b4ca8403a90e647a9", member: "ruff-x86_64-unknown-linux-gnu/ruff" },
    },
  },
  {
    binary: "zizmor",
    version: "1.31.1",
    baseUrl: "https://github.com/zizmorcore/zizmor/releases/download/v1.31.1",
    archive: ArchiveKind.TarGz,
    assets: {
      "darwin-arm64": { file: "zizmor-aarch64-apple-darwin.tar.gz", sha256: "ad5aa633cd56215b11e6c51d51f90c7e6b22904a75047d1215abbd422f61d698" },
      "darwin-x64": { file: "zizmor-x86_64-apple-darwin.tar.gz", sha256: "72ae63bb85b67229c06242f04195cb43927e9fab5f43803c6434dc701a517d61" },
      "linux-arm64": { file: "zizmor-aarch64-unknown-linux-gnu.tar.gz", sha256: "37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833" },
      "linux-x64": { file: "zizmor-x86_64-unknown-linux-gnu.tar.gz", sha256: "d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99" },
    },
  },
  {
    // The checksums file is also signed by poutine's release workflow (sigstore); check that too
    // when updating, as the hashes are only as trustworthy as the file they're copied from.
    binary: "poutine",
    version: "1.1.6",
    baseUrl: "https://github.com/boostsecurityio/poutine/releases/download/v1.1.6",
    archive: ArchiveKind.TarGz,
    assets: {
      "darwin-arm64": { file: "poutine_Darwin_arm64.tar.gz", sha256: "9384f02eeefb4d0778fc61ee4c675e15898b9b01c9cf821dc854d702c4e8a6b2" },
      "darwin-x64": { file: "poutine_Darwin_x86_64.tar.gz", sha256: "27c9b86bd12db19e27c05c22a42dc44492dd00ed2ab7287900b28cd2effb94d3" },
      "linux-arm64": { file: "poutine_Linux_arm64.tar.gz", sha256: "460c90300c6329106b551c150682d12e457365f6436a6cbbd08fe79eb9a98131" },
      "linux-x64": { file: "poutine_Linux_x86_64.tar.gz", sha256: "abde716599a65608b023a69ed9316e5f083a7bca48612151c2720835883757ea" },
    },
  },
]

// Keep in step with semgrep-requirements.txt, which holds this version and the hash of everything
// it depends on. Regenerate that file with:
//   uv pip compile --universal --generate-hashes --python-version 3.10 --only-binary :all: --no-header
export const SEMGREP_VERSION = "1.183.0"
export const SEMGREP_REQUIREMENTS = firstExisting([resolve(import.meta.dirname, "scanner-pins/semgrep-requirements.txt"), resolve(import.meta.dirname, "../../../scanner-pins/semgrep-requirements.txt")])
const SEMGREP_BINARY = "semgrep"
const SEMGREP_COMPLETE_MARKER = ".complete"
const SEMGREP_UNSUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["win32"])
const HAS_SUPPORTED_PYTHON = "import sys; sys.exit(sys.version_info < (3, 10))"
const NEEDS_PYTHON = "it needs Python 3.10 or later, with the venv module"

// Installing Semgrep's dependencies on a slow connection can take several minutes.
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const EXECUTABLE_MODE = 0o755
const LOCK_HASH_CHARS = 12

export interface InstallDependencies {
  readonly download: (url: string) => Promise<Buffer>
  /** Rejects when the command can't start or exits with an error. */
  readonly run: (command: string, args: readonly string[]) => Promise<void>
  readonly log: (message: string) => void
  readonly platform: string
  readonly pins: readonly BinaryPin[]
}

/**
 * Puts pinned scanners where `scannerExecutable` looks first. It runs before a review or the app
 * starts, and from `walkdiff setup`, never as an npm install script: many teams turn those off,
 * and a security tool shouldn't depend on them. Reinstalling is instant once a version is there. A scanner that can't be installed is only
 * logged: a report already says which checks didn't run, and that shouldn't break the install.
 */
export async function installScanners(root: string, deps: InstallDependencies): Promise<void> {
  const tools = join(root, "tools")
  const bin = join(root, "bin")
  await mkdir(tools, { recursive: true })
  await mkdir(bin, { recursive: true })
  await Promise.all([
    ...deps.pins.map((pin) => attempt(pin.binary, bin, deps, () => installBinary(pin, tools, deps))),
    attempt(SEMGREP_BINARY, bin, deps, () => installSemgrep(tools, deps)),
  ])
}

async function attempt(binary: string, bin: string, deps: InstallDependencies, install: () => Promise<string | undefined>): Promise<void> {
  try {
    const executable = await install()
    if (executable === undefined) return
    const link = join(bin, binary)
    await rm(link, { force: true })
    await symlink(relative(bin, executable), link)
  } catch (error: unknown) {
    deps.log(`Walkdiff couldn't install ${binary}: ${error instanceof Error ? error.message : String(error)}. Reports will list it as not run.`)
  }
}

async function installBinary(pin: BinaryPin, tools: string, deps: InstallDependencies): Promise<string | undefined> {
  const asset = pin.assets[deps.platform]
  if (asset === undefined) {
    deps.log(`Walkdiff has no ${pin.binary} build for ${deps.platform}. Install it yourself to use it.`)
    return undefined
  }
  const target = join(tools, `${pin.binary}-${pin.version}`)
  const executable = join(target, pin.binary)
  if (existsSync(executable)) return executable

  deps.log(`Installing ${pin.binary} ${pin.version}…`)
  const bytes = await deps.download(`${pin.baseUrl}/${asset.file}`)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== asset.sha256) throw new Error(`${asset.file} doesn't match its pinned hash (expected ${asset.sha256}, got ${actual})`)

  // Built beside the target and renamed into place, so an interrupted install leaves nothing usable.
  const building = await mkdtemp(join(tools, `.${pin.binary}-`))
  try {
    if (pin.archive === ArchiveKind.TarGz) {
      const archive = join(building, asset.file)
      await writeFile(archive, bytes)
      const member = asset.member ?? pin.binary
      await deps.run("tar", ["-xzf", archive, "-C", building, member])
      await rm(archive)
      if (member !== pin.binary) await moveToTop(building, member, pin.binary)
    } else {
      await writeFile(join(building, pin.binary), bytes)
    }
    await chmod(join(building, pin.binary), EXECUTABLE_MODE)
    await rename(building, target)
  } catch (error: unknown) {
    await rm(building, { recursive: true, force: true })
    throw error
  }
  return executable
}

async function moveToTop(folder: string, member: string, binary: string): Promise<void> {
  const unpacked = join(folder, `${binary}.unpacked`)
  await rename(join(folder, member), unpacked)
  await rm(join(folder, member.split("/").at(0) ?? member), { recursive: true, force: true })
  await rename(unpacked, join(folder, binary))
}

/**
 * Semgrep is a Python application with no standalone build, so it gets a private environment
 * that nothing else on the machine shares. `--require-hashes` holds every package to the locked
 * file, and `--only-binary` means no package's setup code runs. A virtual environment records its
 * own path, so unlike the binaries it can't be built elsewhere and renamed; the marker says it's done.
 */
async function installSemgrep(tools: string, deps: InstallDependencies): Promise<string | undefined> {
  if (SEMGREP_UNSUPPORTED_PLATFORMS.has(deps.platform.split("-").at(0) ?? "")) {
    deps.log("Semgrep doesn't run natively here. Install it yourself, for example in WSL, to use it.")
    return undefined
  }
  // Named for the lock file's contents too, so changing any locked package reinstalls, not only a
  // new Semgrep version.
  const requirements = await readFile(SEMGREP_REQUIREMENTS)
  const target = join(tools, `${SEMGREP_BINARY}-${SEMGREP_VERSION}-${createHash("sha256").update(requirements).digest("hex").slice(0, LOCK_HASH_CHARS)}`)
  const executable = join(target, "bin", SEMGREP_BINARY)
  const marker = join(target, SEMGREP_COMPLETE_MARKER)
  if (existsSync(marker)) return executable

  deps.log(`Installing Semgrep ${SEMGREP_VERSION}…`)
  await rm(target, { recursive: true, force: true })
  try {
    await deps.run("python3", ["-c", HAS_SUPPORTED_PYTHON])
    await deps.run("python3", ["-m", "venv", target])
  } catch {
    await rm(target, { recursive: true, force: true })
    throw new Error(NEEDS_PYTHON)
  }
  await deps.run(join(target, "bin", "python"), ["-m", "pip", "install", "--require-hashes", "--only-binary", ":all:", "--no-input", "--disable-pip-version-check", "--quiet", "-r", SEMGREP_REQUIREMENTS])
  await deps.run(executable, ["--version"])
  await writeFile(marker, "")
  return executable
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error === null) resolvePromise()
      else reject(new Error(stderr.trim().split("\n").at(-1)?.slice(0, 300) || error.message))
    })
  })
}

/** Installs for this machine, into the folder scanners are run from. Quick when they're all there. */
export function installScannersHere(log: (message: string) => void = console.log): Promise<void> {
  const download = (url: string): Promise<Buffer> => downloadWithRetries(url, { fetch, wait: async (ms) => void (await sleep(ms)), log })
  return installScanners(MANAGED_SCANNERS_ROOT, { download, run, log, platform: `${process.platform}-${process.arch}`, pins: BINARY_PINS })
}
