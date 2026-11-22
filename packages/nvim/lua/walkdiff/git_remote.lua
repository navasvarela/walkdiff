-- Where a local branch lives on its host, worked out from git's settings the way `git push` does.
local M = {}

local DEFAULT_REMOTE = "origin"
local BRANCH_REF_PREFIX = "refs/heads/"
-- The push.default modes that push a branch to the branch it tracks, even under another name.
local PUSHES_TO_UPSTREAM = { upstream = true, tracking = true }

local function find(remotes, name)
  for _, remote in ipairs(remotes) do
    if remote.name == name then
      return remote
    end
  end
  return nil
end

--- The remote URL and name a local branch is pushed under, which is where its PR comes from. The
--- branch it tracks doesn't say: one created from `origin/main` tracks `main` but is pushed, and
--- opened as a PR, under its own name. Nil when the repository has no remote with a URL.
---
--- `settings` holds git's settings for the branch: `push_remote` (branch.<name>.pushRemote),
--- `push_default_remote` (remote.pushDefault), `branch_remote` and `merge` (branch.<name>.remote
--- and .merge), and `push_default` (push.default).
function M.host_branch(local_branch, settings, remotes)
  local remote_name = settings.push_remote or settings.push_default_remote or settings.branch_remote or DEFAULT_REMOTE
  local remote = find(remotes, remote_name) or find(remotes, DEFAULT_REMOTE) or remotes[1]
  if remote == nil or remote.url == nil or remote.url == "" then
    return nil
  end
  local branch = local_branch
  local merge = settings.merge
  if PUSHES_TO_UPSTREAM[settings.push_default] and remote.name == settings.branch_remote and merge ~= nil and vim.startswith(merge, BRANCH_REF_PREFIX) then
    branch = merge:sub(#BRANCH_REF_PREFIX + 1)
  end
  return { remote_url = remote.url, branch = branch }
end

return M
