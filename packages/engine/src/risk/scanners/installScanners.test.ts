import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GITLEAKS_BINARY } from "./gitleaks.ts"
import { BINARY_PINS, installScanners, SEMGREP_REQUIREMENTS, SEMGREP_VERSION } from "./installScanners.ts"
import type { BinaryPin, InstallDependencies } from "./installScanners.ts"
import { OSV_SCANNER_BINARY } from "../dependencies/osvScanner.ts"
import { RUFF_BINARY } from "./ruff.ts"
import { ZIZMOR_BINARY } from "./zizmor.ts"

const BYTES = Buffer.from("fake scanner")
const SHA = createHash("sha256").update(BYTES).digest("hex")
const PIN: BinaryPin = { binary: "fake", version: "1.0.0", baseUrl: "https://example.test", archive: "rawBinary", assets: { "linux-x64": { file: "fake_linux", sha256: SHA } } }

describe("installScanners", () => {
  let root = ""
  let downloads: string[] = []
  let commands: string[] = []
  let messages: string[] = []

  const deps = (overrides: Partial<InstallDependencies> = {}): InstallDependencies => ({
    download: async (url) => {
      downloads.push(url)
      return BYTES
    },
    run: async (command, args) => void commands.push([command, ...args].join(" ")),
    log: (message) => void messages.push(message),
    platform: "linux-x64",
    pins: [PIN],
    ...overrides,
  })

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "walkdiff-install-")))
    downloads = []
    commands = []
    messages = []
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it("downloads a verified binary, makes it executable, and links it where scanners run from", async () => {
    await installScanners(root, deps())
    expect(downloads).toEqual(["https://example.test/fake_linux"])
    expect(await readFile(join(root, "bin", "fake"))).toEqual(BYTES)
    expect(await readlink(join(root, "bin", "fake"))).toBe("../tools/fake-1.0.0/fake")
    expect((await lstat(join(root, "tools", "fake-1.0.0", "fake"))).mode & 0o111).toBe(0o111)
  })

  it("moves a binary out of its archive's folder, leaving nothing else behind", async () => {
    const pin: BinaryPin = { binary: "fake", version: "2.0.0", baseUrl: "https://example.test", archive: "tarGz", assets: { "linux-x64": { file: "fake.tar.gz", sha256: SHA, member: "fake-linux/fake" } } }
    const run: InstallDependencies["run"] = async (command, args) => {
      commands.push(command)
      const folder = args.at(args.indexOf("-C") + 1) ?? ""
      await mkdir(join(folder, "fake-linux"))
      await writeFile(join(folder, "fake-linux", "fake"), BYTES)
    }
    await installScanners(root, deps({ pins: [pin], run }))
    expect(await readFile(join(root, "bin", "fake"))).toEqual(BYTES)
    expect(await readdir(join(root, "tools", "fake-2.0.0"))).toEqual(["fake"])
  })

  it("refuses a download that doesn't match its hash, leaving nothing behind and not failing", async () => {
    await installScanners(root, deps({ download: async () => Buffer.from("tampered") }))
    expect(messages.join()).toContain("doesn't match its pinned hash")
    await expect(lstat(join(root, "bin", "fake"))).rejects.toThrow()
    await expect(lstat(join(root, "tools", "fake-1.0.0"))).rejects.toThrow()
  })

  it("doesn't download a version it already has", async () => {
    await installScanners(root, deps())
    await installScanners(root, deps())
    expect(downloads).toHaveLength(1)
  })

  it("leaves a platform with no build to the PATH", async () => {
    await installScanners(root, deps({ platform: "freebsd-x64" }))
    expect(downloads).toEqual([])
    expect(messages.join()).toContain("no fake build for freebsd-x64")
  })

  it("survives a failed download", async () => {
    await installScanners(root, deps({ download: async () => Promise.reject(new Error("offline")) }))
    expect(messages.join()).toContain("couldn't install fake: offline")
  })

  it("installs Semgrep from the hash-locked file, with no package's setup code running", async () => {
    const run: InstallDependencies["run"] = async (command, args) => {
      commands.push([command, ...args].join(" "))
      const venv = args.at(args.indexOf("venv") + 1)
      if (args.includes("venv") && venv !== undefined) await mkdir(venv, { recursive: true })
    }
    await installScanners(root, deps({ pins: [], run }))
    const pip = commands.find((command) => command.includes("pip install"))
    expect(pip).toContain("--require-hashes")
    expect(pip).toContain("--only-binary :all:")
    expect(pip).toContain(SEMGREP_REQUIREMENTS)
    expect(await readlink(join(root, "bin", "semgrep"))).toMatch(new RegExp(`^\\.\\./tools/semgrep-${SEMGREP_VERSION}-[0-9a-f]{12}/bin/semgrep$`))
  })

  it("says what Semgrep needs when Python is missing", async () => {
    await installScanners(root, deps({ pins: [], run: async () => Promise.reject(new Error("ENOENT")) }))
    expect(messages.join()).toContain("needs Python 3.10")
    await expect(lstat(join(root, "bin", "semgrep"))).rejects.toThrow()
  })

  it("leaves Semgrep to the PATH on Windows", async () => {
    await installScanners(root, deps({ pins: [], platform: "win32-x64" }))
    expect(commands).toEqual([])
  })
})

describe("the pins", () => {
  it("use the names scanners are run by", () => {
    expect(BINARY_PINS.map((pin) => pin.binary)).toEqual([GITLEAKS_BINARY, OSV_SCANNER_BINARY, RUFF_BINARY, ZIZMOR_BINARY])
  })

  it("lock the Semgrep version the installer names, and hash every package", async () => {
    const requirements = await readFile(SEMGREP_REQUIREMENTS, "utf8")
    expect(requirements).toContain(`semgrep==${SEMGREP_VERSION} `)
    const packages = requirements.split("\n").filter((line) => /^\S+==/.test(line))
    expect(packages.length).toBeGreaterThan(10)
    expect(packages.every((line) => line.trimEnd().endsWith("\\"))).toBe(true)
  })
})
