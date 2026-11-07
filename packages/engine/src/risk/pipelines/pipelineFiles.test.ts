import type { FileDiff } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import type { ScannedFile } from "../scannedFile.ts"
import { readPipelineFiles } from "./pipelineFiles.ts"
import type { ReadHeadFiles } from "./pipelineFiles.ts"

function changed(path: string, after = "x: 1\n"): ScannedFile {
  const diff: FileDiff = { status: "modified", path, additions: 1, deletions: 0, content: { kind: "text", hunks: [] } }
  return { diff, noise: null, after }
}

/** A repository at the head, recording which paths were read. */
function repository(files: Readonly<Record<string, string>>): { readonly read: ReadHeadFiles; readonly reads: string[] } {
  const reads: string[] = []
  const read: ReadHeadFiles = async (paths) => {
    reads.push(...paths)
    return paths.map((path) => files[path])
  }
  return { read, reads }
}

const GRAPH = {
  ".gitlab-ci.yml": "include:\n  - local: /ci/build.yml\n  - 'ci/*.yml'\n  - local: $TEMPLATE\nbuild:\n  script: [make]\n",
  "ci/build.yml": "include: ci/deploy.yml\n",
  "ci/deploy.yml": "include: .gitlab-ci.yml\ndeploy:\n  script: [make deploy]\n",
  "k8s/app.yaml": "kind: Deployment\n",
}

describe("readPipelineFiles", () => {
  it("follows local includes from the root when a change edits an included file", async () => {
    const { read } = repository(GRAPH)
    const pipeline = await readPipelineFiles([changed("ci/deploy.yml")], read)
    expect(pipeline.map((file) => [file.path, file.system])).toEqual([
      [".gitlab-ci.yml", "gitlabCi"],
      ["ci/build.yml", "gitlabCi"],
      ["ci/deploy.yml", "gitlabCi"],
    ])
  })

  it("reads nothing when the change touches no YAML", async () => {
    const { read, reads } = repository(GRAPH)
    expect(await readPipelineFiles([changed("src/app.ts")], read)).toEqual([])
    expect(reads).toEqual([])
  })

  it("returns nothing when the changed YAML isn't part of a pipeline", async () => {
    const { read } = repository(GRAPH)
    expect(await readPipelineFiles([changed("k8s/app.yaml")], read)).toEqual([])
  })

  it("adds Azure Pipelines and Tekton files the change touches, and GitLab CI files named as such", async () => {
    const { read } = repository({})
    const files = [changed("azure-pipelines.yml", "a"), changed(".tekton/push.yaml", "t"), changed("templates/deploy.gitlab-ci.yml", "g"), changed("tekton/other.yaml")]
    const pipeline = await readPipelineFiles(files, read)
    expect(pipeline.map((file) => [file.path, file.system, file.text])).toEqual([
      ["azure-pipelines.yml", "azurePipelines", "a"],
      [".tekton/push.yaml", "tekton", "t"],
      ["templates/deploy.gitlab-ci.yml", "gitlabCi", "g"],
    ])
  })

  it("leaves out lockfiles and vendored files", async () => {
    const { read, reads } = repository(GRAPH)
    const vendored = { ...changed("vendor/.gitlab-ci.yml"), noise: { kind: "vendored", reason: "" } } as const
    expect(await readPipelineFiles([vendored], read)).toEqual([])
    expect(reads).toEqual([])
  })
})
