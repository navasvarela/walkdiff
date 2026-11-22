-- The repository the user is in, read with the git command line.
local errors = require("walkdiff.errors")
local git_remote = require("walkdiff.git_remote")

local M = {}

local DETACHED_HEAD = "HEAD"

local function git(root, args)
  local result = vim.system(vim.list_extend({ "git", "-C", root }, args), { text = true }):wait()
  if result.code ~= 0 then
    return nil
  end
  return vim.trim(result.stdout or "")
end

--- The repository of the current buffer's file, or of the working directory.
local function repository_root()
  local root = vim.fs.root(0, ".git") or vim.fs.root(vim.fn.getcwd(), ".git")
  if root == nil then
    error(errors.user("Open a file in a git repository from GitHub or GitLab first."))
  end
  return root
end

local function remotes(root)
  local listed = {}
  for name in (git(root, { "remote" }) or ""):gmatch("[^\n]+") do
    table.insert(listed, { name = name, url = git(root, { "remote", "get-url", name }) })
  end
  return listed
end

--- The current branch's remote URL and name on its host.
function M.current_host_branch()
  local root = repository_root()
  local branch = git(root, { "rev-parse", "--abbrev-ref", "HEAD" })
  if branch == nil or branch == DETACHED_HEAD then
    error(errors.user("Check out a branch first: this repository is on a detached HEAD."))
  end
  local function setting(name)
    return git(root, { "config", "--get", name })
  end
  local host_branch = git_remote.host_branch(branch, {
    push_remote = setting("branch." .. branch .. ".pushRemote"),
    push_default_remote = setting("remote.pushDefault"),
    branch_remote = setting("branch." .. branch .. ".remote"),
    merge = setting("branch." .. branch .. ".merge"),
    push_default = setting("push.default"),
  }, remotes(root))
  if host_branch == nil then
    error(errors.user("This repository has no remote, so Walkdiff can't tell where its pull requests are."))
  end
  return host_branch
end

return M
