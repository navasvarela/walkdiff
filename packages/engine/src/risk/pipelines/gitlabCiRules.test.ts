import type { FileDiff } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import type { ScannedFile } from "../scannedFile.ts"
import { scanGitlabCi } from "./gitlabCiRules.ts"
import { PipelineSystem } from "./pipelineFiles.ts"
import type { PipelineFile } from "./pipelineFiles.ts"

const CI_FILE = ".gitlab-ci.yml"

/** A GitLab CI file the change added in full, unless `addedLines` says otherwise. */
function ciChange(text: string, addedLines?: readonly number[], path = CI_FILE): { readonly file: ScannedFile; readonly pipeline: PipelineFile[] } {
  const lines = text.split("\n")
  const added = addedLines ?? lines.map((_, index) => index + 1)
  const diff: FileDiff = {
    status: "modified",
    path,
    additions: added.length,
    deletions: 0,
    content: { kind: "text", hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, section: "", lines: added.map((line) => ({ kind: "added", content: lines.at(line - 1) ?? "", newLine: line })) }] },
  }
  return { file: { diff, noise: null, after: text }, pipeline: [{ path, text, system: PipelineSystem.GitlabCi }] }
}

function ruleIdsFor(text: string): string[] {
  const { file, pipeline } = ciChange(text)
  return scanGitlabCi([file], pipeline).map((finding) => finding.ruleId)
}

describe("scanGitlabCi", () => {
  it.each([
    ["eval of the MR title", "job:\n  script:\n    - eval \"echo $CI_MERGE_REQUEST_TITLE\"", "gitlab-ci.mr-text-as-command"],
    ["bash -c with the branch name", "job:\n  script:\n    - bash -c \"deploy ${CI_COMMIT_REF_NAME}\"", "gitlab-ci.mr-text-as-command"],
    ["python -c with a commit message", "job:\n  script:\n    - |\n      python3 -c \"print('$CI_COMMIT_MESSAGE')\"", "gitlab-ci.mr-text-as-command"],
    ["a remote include with no integrity", "include:\n  - remote: https://example.com/ci.yml", "gitlab-ci.remote-include-unverified"],
    ["a remote include given as a URL", "include: https://example.com/ci.yml", "gitlab-ci.remote-include-unverified"],
    ["a project include with no ref", "include:\n  - project: group/shared\n    file: /build.yml", "gitlab-ci.project-include-unpinned"],
    ["a component on ~latest", "include:\n  - component: gitlab.com/org/c/build@~latest", "gitlab-ci.component-unpinned"],
    ["a component on a branch", "include:\n  - component: gitlab.com/org/c/build@main", "gitlab-ci.component-unpinned"],
    ["an image on latest", "job:\n  image: node:latest", "gitlab-ci.image-unpinned"],
    ["an image with no tag", "job:\n  image: node", "gitlab-ci.image-unpinned"],
    ["a service with no tag, behind a registry port", "job:\n  services:\n    - registry.local:5000/postgres", "gitlab-ci.image-unpinned"],
  ])("flags %s", (_case, text, ruleId) => {
    expect(ruleIdsFor(text)).toEqual([ruleId])
  })

  it.each([
    ["the MR title as an ordinary argument", "job:\n  script:\n    - echo \"$CI_MERGE_REQUEST_TITLE\""],
    ["eval of a value the MR can't set", "job:\n  script:\n    - eval \"$(ssh-agent -s)\""],
    ["the slug GitLab makes safe", "job:\n  script:\n    - sh -c \"deploy $CI_COMMIT_REF_SLUG\""],
    ["a remote include with integrity", "include:\n  - remote: https://example.com/ci.yml\n    integrity: sha256-L3/GAoKaw0Arw6hDCKeKQlV1QPEgHYxGBHsH4zG1IY8="],
    ["a project include with a ref", "include:\n  - project: group/shared\n    ref: v1.4.0\n    file: /build.yml"],
    ["a component on a release", "include:\n  - component: gitlab.com/org/c/build@1.2.3"],
    ["a component on a commit", "include:\n  - component: gitlab.com/org/c/build@0123456789abcdef0123456789abcdef01234567"],
    ["an image with a tag", "job:\n  image: node:22-alpine"],
    ["an image with a digest", `job:\n  image: node@sha256:${"a".repeat(64)}`],
    ["an image named by a variable", "job:\n  image: $BUILD_IMAGE"],
    ["a local include", "include: ci/build.yml"],
  ])("doesn't flag %s", (_case, text) => {
    expect(ruleIdsFor(text)).toEqual([])
  })

  it("flags only lines the change added, and shows the line", () => {
    const { file, pipeline } = ciChange("job:\n  image: node\nother:\n  image: ruby:latest", [4])
    expect(scanGitlabCi([file], pipeline)).toMatchObject([{ ruleId: "gitlab-ci.image-unpinned", location: { path: CI_FILE, line: 4 }, evidence: "image: ruby:latest" }])
  })

  it("checks only files that belong to the GitLab pipeline", () => {
    const { file } = ciChange("job:\n  image: node", undefined, "k8s/job.yaml")
    expect(scanGitlabCi([file], [])).toEqual([])
  })
})
