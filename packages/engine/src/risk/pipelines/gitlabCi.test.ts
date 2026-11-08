import { describe, expect, it } from "vitest"
import { parseGitlabCi } from "./gitlabCi.ts"

describe("parseGitlabCi", () => {
  it("reads every form of include, with the line each starts on", () => {
    const config = parseGitlabCi(
      [
        "include:",
        "  - 'ci/build.yml'",
        "  - https://example.com/a.yml",
        "  - local: /ci/deploy.yml",
        "  - remote: https://example.com/b.yml",
        "    integrity: sha256-abc",
        "  - project: group/shared",
        "    file: /t.yml",
        "  - project: group/pinned",
        "    ref: v1.2.0",
        "    file: /t.yml",
        "  - component: gitlab.com/org/comp/build@~latest",
        "  - template: Auto-DevOps.gitlab-ci.yml",
      ].join("\n"),
    )
    expect(config.includes).toEqual([
      { kind: "local", path: "ci/build.yml", line: 2 },
      { kind: "remote", url: "https://example.com/a.yml", hasIntegrity: false, line: 3 },
      { kind: "local", path: "/ci/deploy.yml", line: 4 },
      { kind: "remote", url: "https://example.com/b.yml", hasIntegrity: true, line: 5 },
      { kind: "project", project: "group/shared", ref: undefined, line: 7 },
      { kind: "project", project: "group/pinned", ref: "v1.2.0", line: 9 },
      { kind: "component", component: "gitlab.com/org/comp/build@~latest", line: 12 },
      { kind: "template", line: 13 },
    ])
  })

  it.each([
    ["a single string", "include: 'ci/a.yml'\n"],
    ["a single mapping", "include:\n  local: ci/a.yml\n"],
    ["a flow list", "include: [ci/a.yml]\n"],
  ])("reads an include given as %s", (_form, text) => {
    expect(parseGitlabCi(text).includes).toMatchObject([{ kind: "local", path: "ci/a.yml" }])
  })

  it("finds images on jobs, defaults and services, whether named directly or through `name`", () => {
    const config = parseGitlabCi(
      ["image: node:latest", "default:", "  image:", "    name: ruby", "build:", "  image: python:3.12", "  services:", "    - postgres", "    - name: redis:7"].join("\n"),
    )
    expect(config.images).toEqual([
      { text: "node:latest", line: 1 },
      { text: "ruby", line: 4 },
      { text: "python:3.12", line: 6 },
      { text: "postgres", line: 8 },
      { text: "redis:7", line: 9 },
    ])
  })

  it("gives each line of a multi-line script its own line number", () => {
    const config = parseGitlabCi(["build:", "  script:", "    - echo one", "    - |", "      echo two", "      eval \"$X\"", "  after_script: [echo three]"].join("\n"))
    expect(config.scriptLines.filter((line) => line.text.trim() !== "" && line.text.trim() !== "|").map((line) => [line.text.trim(), line.line])).toEqual([
      ["echo one", 3],
      ["echo two", 5],
      ['eval "$X"', 6],
      ["echo three", 7],
    ])
  })

  it("doesn't treat variables or inputs as jobs", () => {
    const config = parseGitlabCi(["spec:", "  inputs:", "    image:", "      default: alpine", "---", "variables:", "  image: alpine", "  script: eval $CI_COMMIT_MESSAGE"].join("\n"))
    expect(config.images).toEqual([])
    expect(config.scriptLines).toEqual([])
  })

  it("reads includes from a file's second document, after its `spec` header", () => {
    expect(parseGitlabCi("spec:\n  inputs: {}\n---\ninclude: ci/a.yml\n").includes).toMatchObject([{ kind: "local", path: "ci/a.yml" }])
  })

  it("survives broken YAML and doesn't expand aliases", () => {
    expect(() => parseGitlabCi("build: [unclosed\n  script: :")).not.toThrow()
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 12 }, (_, index) => `${String.fromCharCode(98 + index)}: &${String.fromCharCode(98 + index)} [*${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}, *${String.fromCharCode(97 + index)}]`), "job:", "  script: *m"].join("\n")
    expect(parseGitlabCi(bomb).scriptLines).toEqual([])
  })
})
