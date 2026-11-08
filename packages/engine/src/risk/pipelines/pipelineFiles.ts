import { isThirdParty } from "../scannedFile.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { IncludeKind, parseGitlabCi } from "./gitlabCi.ts"

export const PipelineSystem = { GitlabCi: "gitlabCi", AzurePipelines: "azurePipelines", Tekton: "tekton" } as const
export type PipelineSystem = (typeof PipelineSystem)[keyof typeof PipelineSystem]

/** A CI configuration file as it is at the head of the change. */
export interface PipelineFile {
  readonly path: string
  readonly text: string
  readonly system: PipelineSystem
}

/** Head text of each path, aligned by index; undefined where the file doesn't exist. */
export type ReadHeadFiles = (paths: readonly string[]) => Promise<(string | undefined)[]>

const GITLAB_CI_ROOT = ".gitlab-ci.yml"
// poutine stops following includes after this many files, so reading more would only cost time.
const MAX_GITLAB_CI_FILES = 150
const YAML_FILE = /\.ya?ml$/
// The file names poutine recognises for each system, so both see the same files.
const GITLAB_CI_FILE = /\.?gitlab-ci(-.+)?\.ya?ml$/
const AZURE_PIPELINES_FILE = /\.?azure-pipelines(-.+)?\.ya?ml$/
const TEKTON_FILE = /^\.tekton\/[^/]+\.ya?ml$/
// GitLab expands these when it reads the config, so the file can't be known in advance.
const UNRESOLVABLE_PATH = /[*$]/

/**
 * The CI files a change touches, plus the GitLab CI files around them. Pipeline checks need the
 * whole include graph: GitLab, and poutine, start from `.gitlab-ci.yml` and follow its local
 * includes, so an MR that edits only `ci/deploy.yml` means nothing without the root that includes
 * it. Returns nothing when the change touches no CI file, which is most changes.
 */
export async function readPipelineFiles(files: readonly ScannedFile[], read: ReadHeadFiles): Promise<PipelineFile[]> {
  const changed = files.filter((file) => file.after !== undefined && !isThirdParty(file) && YAML_FILE.test(file.diff.path))
  if (changed.length === 0) return []
  const gitlab = await readGitlabCiGraph(read)
  const known = new Set(gitlab.map((file) => file.path))
  const named = changed.flatMap((file): PipelineFile[] => {
    const system = systemByName(file.diff.path)
    return system === undefined || file.after === undefined || known.has(file.diff.path) ? [] : [{ path: file.diff.path, text: file.after, system }]
  })
  const pipeline = [...gitlab, ...named]
  const changedPaths = new Set(changed.map((file) => file.diff.path))
  return pipeline.some((file) => changedPaths.has(file.path)) ? pipeline : []
}

function systemByName(path: string): PipelineSystem | undefined {
  if (GITLAB_CI_FILE.test(path)) return PipelineSystem.GitlabCi
  if (AZURE_PIPELINES_FILE.test(path)) return PipelineSystem.AzurePipelines
  if (TEKTON_FILE.test(path)) return PipelineSystem.Tekton
  return undefined
}

/** Breadth first from the root, one batch of reads per level of includes. */
async function readGitlabCiGraph(read: ReadHeadFiles): Promise<PipelineFile[]> {
  const found: PipelineFile[] = []
  const seen = new Set<string>()
  let level = [GITLAB_CI_ROOT]
  while (level.length > 0 && found.length < MAX_GITLAB_CI_FILES) {
    const paths = level.filter((path) => !seen.has(path)).slice(0, MAX_GITLAB_CI_FILES - found.length)
    for (const path of paths) seen.add(path)
    const texts = await read(paths)
    const next: string[] = []
    paths.forEach((path, index) => {
      const text = texts.at(index)
      if (text === undefined) return
      found.push({ path, text, system: PipelineSystem.GitlabCi })
      next.push(...localIncludes(text))
    })
    level = next
  }
  return found
}

function localIncludes(text: string): string[] {
  return parseGitlabCi(text).includes.flatMap((include) => {
    if (include.kind !== IncludeKind.Local || UNRESOLVABLE_PATH.test(include.path)) return []
    // Local includes are always relative to the repository root, with or without a leading slash.
    return [include.path.replace(/^\/+/, "")]
  })
}
