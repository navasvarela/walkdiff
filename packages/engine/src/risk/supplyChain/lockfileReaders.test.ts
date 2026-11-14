import { describe, expect, it } from "vitest"
import type { LockedPackage, LockfileReader } from "./lockedPackage.ts"
import { PACKAGE_LOCK, PNPM_LOCK, YARN_LOCK } from "./npmLockfiles.ts"
import { CARGO_LOCK, GO_SUM, POETRY_LOCK, UV_LOCK } from "./otherLockfiles.ts"
import { isInsecure, originKey } from "./packageOrigin.ts"

function summary(entry: LockedPackage): string {
  const flags = [entry.runsInstallScript ? "install" : "", isInsecure(entry.origin) ? "insecure" : ""].filter((flag) => flag !== "")
  return [entry.name, entry.version, originKey(entry.origin), ...flags].join(" ")
}

const PACKAGE_LOCK_TEXT = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "packages/web": { name: "web", version: "1.0.0" },
    "node_modules/web": { resolved: "packages/web", link: true },
    "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-abc" },
    "node_modules/a/node_modules/esbuild": { version: "0.21.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.21.0.tgz", integrity: "sha512-e", hasInstallScript: true },
    "node_modules/forked": { version: "2.0.0", resolved: "git+ssh://git@github.com/acme/forked.git#0123abc" },
    "node_modules/tool": { version: "1.0.0", resolved: "http://downloads.example.com/tool.tgz" },
  },
})

const YARN_CLASSIC_TEXT = `# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
  version "7.12.13"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#dcfc8"
  integrity sha512-abc
  dependencies:
    "@babel/highlight" "^7.10.4"

left-pad@^1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a"
  integrity sha512-def
`

const YARN_BERRY_TEXT = `__metadata:
  version: 8
  cacheKey: 10c0

"left-pad@npm:^1.3.0":
  version: 1.3.0
  resolution: "left-pad@npm:1.3.0"
  checksum: 10c0/abc
  languageName: node
  linkType: hard

"forked@https://github.com/acme/forked.git#commit=0123":
  version: 2.0.0
  resolution: "forked@https://github.com/acme/forked.git#commit=0123"
  languageName: node
  linkType: hard

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  languageName: unknown
  linkType: soft
`

const PNPM_V9_TEXT = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:
  '@scope/pkg@2.0.0':
    resolution: {integrity: sha512-xyz}
  left-pad@1.3.0:
    resolution: {integrity: sha512-abc}
  forked@https://codeload.github.com/acme/forked/tar.gz/0123:
    resolution: {tarball: https://codeload.github.com/acme/forked/tar.gz/0123}
    version: 2.0.0
  repo@git+https://github.com/acme/repo.git#0123:
    resolution: {commit: '0123', repo: 'https://github.com/acme/repo.git', type: git}
    version: 1.0.0
`

const PNPM_TWO_DOCUMENTS_TEXT = `---
lockfileVersion: '9.0'

packages:
  pnpm@10.0.0:
    resolution: {integrity: sha512-p}

---
lockfileVersion: '9.0'

packages:
  left-pad@1.3.0:
    resolution: {integrity: sha512-abc}
`

const PNPM_V6_TEXT = `lockfileVersion: '6.0'
packages:
  /esbuild@0.18.0:
    resolution: {integrity: sha512-e}
    requiresBuild: true
  /react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-r}
`

const PNPM_V5_TEXT = `lockfileVersion: 5.4
packages:
  /@babel/core/7.20.0:
    resolution: {integrity: sha512-b}
  /react-dom/18.2.0_react@18.2.0:
    resolution: {integrity: sha512-r}
`

const CARGO_TEXT = `version = 3

[[package]]
name = "app"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"

[[package]]
name = "forked"
version = "0.2.0"
source = "git+https://github.com/acme/forked?branch=main#0123"
`

const UV_TEXT = `version = 1

[[package]]
name = "Anyio"
version = "4.4.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/anyio-4.4.0.tar.gz", hash = "sha256:aaa" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/anyio-4.4.0-py3-none-any.whl", hash = "sha256:bbb" },
]

[[package]]
name = "internal"
version = "1.0.0"
source = { registry = "https://pypi.acme.internal/simple" }

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
`

const POETRY_TEXT = `[[package]]
name = "requests"
version = "2.32.0"
description = "HTTP"
optional = false
python-versions = ">=3.8"
files = [
    {file = "requests-2.32.0.tar.gz", hash = "sha256:ccc"},
]

[[package]]
name = "forked"
version = "1.0.0"
description = ""
optional = false
python-versions = "*"
files = []

[package.source]
type = "git"
url = "https://github.com/acme/forked.git"
reference = "main"
resolved_reference = "0123"
`

const GO_SUM_TEXT = "github.com/spf13/cobra v1.8.0 h1:abc=\ngithub.com/spf13/cobra v1.8.0/go.mod h1:def=\n"

describe("lockfile readers", () => {
  it.each<[string, LockfileReader, string, string[]]>([
    [
      "package-lock.json",
      PACKAGE_LOCK,
      PACKAGE_LOCK_TEXT,
      [
        "left-pad 1.3.0 registry:registry.npmjs.org",
        "esbuild 0.21.0 registry:registry.npmjs.org install",
        "forked 2.0.0 git:ssh://git@github.com/acme/forked.git",
        "tool 1.0.0 url:downloads.example.com insecure",
      ],
    ],
    ["yarn.lock (Yarn 1)", YARN_LOCK, YARN_CLASSIC_TEXT, ["@babel/code-frame 7.12.13 registry:registry.npmjs.org", "left-pad 1.3.0 registry:registry.npmjs.org"]],
    [
      "yarn.lock (Yarn 2+)",
      YARN_LOCK,
      YARN_BERRY_TEXT,
      ["left-pad 1.3.0 registry:the configured registry", "forked 2.0.0 git:https://github.com/acme/forked.git", "app 0.0.0-use.local local"],
    ],
    [
      "pnpm-lock.yaml v9",
      PNPM_LOCK,
      PNPM_V9_TEXT,
      [
        "@scope/pkg 2.0.0 registry:the configured registry",
        "left-pad 1.3.0 registry:the configured registry",
        "forked 2.0.0 url:codeload.github.com",
        "repo 1.0.0 git:https://github.com/acme/repo.git",
      ],
    ],
    ["pnpm-lock.yaml with pnpm's own tools first", PNPM_LOCK, PNPM_TWO_DOCUMENTS_TEXT, ["pnpm 10.0.0 registry:the configured registry", "left-pad 1.3.0 registry:the configured registry"]],
    ["pnpm-lock.yaml v6", PNPM_LOCK, PNPM_V6_TEXT, ["esbuild 0.18.0 registry:the configured registry install", "react-dom 18.2.0 registry:the configured registry"]],
    ["pnpm-lock.yaml v5", PNPM_LOCK, PNPM_V5_TEXT, ["@babel/core 7.20.0 registry:the configured registry", "react-dom 18.2.0 registry:the configured registry"]],
    ["Cargo.lock", CARGO_LOCK, CARGO_TEXT, ["app 0.1.0 local", "serde 1.0.200 registry:crates.io", "forked 0.2.0 git:https://github.com/acme/forked"]],
    ["uv.lock", UV_LOCK, UV_TEXT, ["anyio 4.4.0 registry:pypi.org", "internal 1.0.0 registry:pypi.acme.internal", "app 0.1.0 local"]],
    ["poetry.lock", POETRY_LOCK, POETRY_TEXT, ["requests 2.32.0 registry:pypi.org", "forked 1.0.0 git:https://github.com/acme/forked.git"]],
    ["go.sum", GO_SUM, GO_SUM_TEXT, ["github.com/spf13/cobra v1.8.0 registry:the Go module proxy", "github.com/spf13/cobra v1.8.0/go.mod registry:the Go module proxy"]],
  ])("reads %s", (_name, reader, text, expected) => {
    expect(reader.read(text).map(summary)).toEqual(expected)
  })

  it("keys hashes by algorithm, or by file and algorithm for Python releases", () => {
    const [npm] = PACKAGE_LOCK.read(PACKAGE_LOCK_TEXT)
    const [berry] = YARN_LOCK.read(YARN_BERRY_TEXT)
    const [anyio] = UV_LOCK.read(UV_TEXT)
    expect([...(npm?.hashes ?? [])]).toEqual([["sha512", "sha512-abc"]])
    expect([...(berry?.hashes ?? [])]).toEqual([["10c0", "abc"]])
    expect([...(anyio?.hashes.keys() ?? [])]).toEqual(["anyio-4.4.0.tar.gz sha256", "anyio-4.4.0-py3-none-any.whl sha256"])
  })

  it("throws on text that isn't a lockfile, so the scan can say it couldn't read it", () => {
    expect(() => PACKAGE_LOCK.read("not json")).toThrow()
  })
})
