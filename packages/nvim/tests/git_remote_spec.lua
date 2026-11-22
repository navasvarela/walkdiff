local git_remote = require("walkdiff.git_remote")

local ORIGIN = { name = "origin", url = "git@github.com:me/app.git" }
local UPSTREAM = { name = "upstream", url = "git@github.com:acme/app.git" }
local FORK = { name = "fork", url = "git@github.com:me/app-fork.git" }

describe("host_branch", function()
  it("uses the local name, even for a branch created from origin/main, which tracks main", function()
    eq(git_remote.host_branch("fix", { branch_remote = "origin", merge = "refs/heads/main" }, { ORIGIN }), { remote_url = ORIGIN.url, branch = "fix" })
  end)

  it("uses the tracked branch's name when push.default pushes to it", function()
    eq(
      git_remote.host_branch("fix", { branch_remote = "upstream", merge = "refs/heads/fix-retries", push_default = "upstream" }, { ORIGIN, UPSTREAM }),
      { remote_url = UPSTREAM.url, branch = "fix-retries" }
    )
  end)

  it("pushes to the branch's push remote, then the default push remote, then the one it tracks", function()
    local remotes = { ORIGIN, UPSTREAM, FORK }
    eq(git_remote.host_branch("fix", { push_remote = "fork", push_default_remote = "upstream", branch_remote = "origin" }, remotes).remote_url, FORK.url)
    eq(git_remote.host_branch("fix", { push_default_remote = "upstream", branch_remote = "origin" }, remotes).remote_url, UPSTREAM.url)
    eq(git_remote.host_branch("fix", { branch_remote = "upstream" }, remotes).remote_url, UPSTREAM.url)
  end)

  it("falls back to origin, then the only remote there is", function()
    eq(git_remote.host_branch("fix", {}, { UPSTREAM, ORIGIN }), { remote_url = ORIGIN.url, branch = "fix" })
    eq(git_remote.host_branch("fix", {}, { { name = "mine", url = "https://gitlab.com/g/app.git" } }), { remote_url = "https://gitlab.com/g/app.git", branch = "fix" })
  end)

  it("finds nothing without a remote", function()
    eq(git_remote.host_branch("fix", {}, {}), nil)
  end)
end)
