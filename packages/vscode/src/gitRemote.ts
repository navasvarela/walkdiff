export interface GitRemote {
  readonly name: string
  readonly fetchUrl?: string | undefined
  readonly pushUrl?: string | undefined
}

/** The branch's name and remote on the host, where they're known. */
export interface Upstream {
  readonly remote: string
  readonly name: string
}

export interface HostBranch {
  readonly remoteUrl: string
  readonly branch: string
}

const DEFAULT_REMOTE = "origin"

/**
 * Where a local branch lives on its host: the remote and name it tracks, or `origin` and the local
 * name when it tracks nothing yet. Undefined when the repository has no remote with a URL.
 */
export function hostBranch(localBranch: string, upstream: Upstream | undefined, remotes: readonly GitRemote[]): HostBranch | undefined {
  const remote = remotes.find((candidate) => candidate.name === upstream?.remote) ?? remotes.find((candidate) => candidate.name === DEFAULT_REMOTE) ?? remotes[0]
  const remoteUrl = remote?.fetchUrl ?? remote?.pushUrl
  if (remoteUrl === undefined) return undefined
  // A branch tracking another remote's branch is on the host under that branch's name.
  const branch = upstream !== undefined && upstream.remote === remote?.name ? upstream.name : localBranch
  return { remoteUrl, branch }
}
