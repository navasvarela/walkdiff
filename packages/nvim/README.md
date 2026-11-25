# Walkdiff for Neovim

Review GitHub pull requests and GitLab merge requests in Neovim with [Walkdiff](https://github.com/navasvarela/walkdiff): each changed function whole, where the rest of the code uses it, and what looks risky.

## What it does

- **`:Walkdiff branch`** finds the open pull request for the branch you have checked out and starts a review.
- **`:Walkdiff requests`** lists the open pull requests that ask you for a review, on the host of the repository you're in, and reviews the one you pick.
- **`:Walkdiff link <url>`** reviews any pull request or merge request.
- **`:Walkdiff`** (or `:Walkdiff list`) opens the reviews list, with each review's progress. It says when a review is ready.
  - `<CR>` on a finished review shows its changed files, with lockfiles, generated and vendored files last, and the findings in each, worst first. Findings about the pull request as a whole come first.
  - `<CR>` on a file opens it in a new tab, base and head side by side in diff mode, without checking the pull request out. `<CR>` on a finding opens it at its line.
  - `o` opens the full report in your browser, `a` analyzes the review again after new commits, `D` removes it from the list, `r` refreshes and `q` closes.
- **Findings** show as diagnostics on the files at the pull request's head, and **`:Walkdiff findings`** puts a review's findings in the quickfix list.
- **`:Walkdiff report`** opens a review's report in your browser, with the review path, where changed code is used, and the Conversation tab for posting your review.

## How it works

Reviews run in the Walkdiff app on your machine (`npx walkdiff app`), the same one that serves the review list in your browser. The plugin finds the running app from the connection file it writes, and offers to start it in a terminal if it isn't running (`:Walkdiff start` does it straight away). Your GitHub or GitLab login stays with the app: the plugin never sees a token.

It talks to the app with `curl`, passing the app's key on curl's standard input, so the key never appears in the process list. The API is described in [docs/app-api.md](../../docs/app-api.md).

You need Neovim 0.10 or later, `curl`, `git`, and Walkdiff 0.14.0 or later with Node.js 22.18 or later. For private repositories, the app needs a login: `GITHUB_TOKEN`, the GitHub CLI's login, or `GITLAB_TOKEN`. For GitHub Enterprise or self-managed GitLab, add the host to `WALKDIFF_TRUSTED_GITHUB_HOSTS` or `WALKDIFF_TRUSTED_GITLAB_HOSTS`, as the [configuration guide](../../docs/configuration.md) describes.

`:Walkdiff branch` looks for the pull request where `git push` sends your branch: its push remote, or the remote it tracks, or `origin`, under the branch's own name (or the tracked branch's, with `push.default=upstream`).

## Installing

The plugin lives in the `packages/nvim` folder of the Walkdiff repository, so it's added from there. Its releases are tagged `nvim-v0.1.0` and so on; pin one to stay on a release rather than the repository's main branch.

With [lazy.nvim](https://github.com/folke/lazy.nvim), which has no option for a subfolder:

```lua
{
  "navasvarela/walkdiff",
  tag = "nvim-v0.1.0",
  config = function(plugin)
    vim.opt.runtimepath:append(plugin.dir .. "/packages/nvim")
    vim.cmd.runtime("plugin/walkdiff.lua")
    require("walkdiff").setup({})
  end,
}
```

With [vim-plug](https://github.com/junegunn/vim-plug):

```vim
Plug 'navasvarela/walkdiff', { 'rtp': 'packages/nvim', 'tag': 'nvim-v0.1.0' }
```

With Neovim's own packages, clone the repository anywhere, check out a release with `git checkout nvim-v0.1.0`, and add the folder to your `init.lua`:

```lua
vim.opt.runtimepath:append("/path/to/walkdiff/packages/nvim")
```

## Settings

`setup` is optional; these are the defaults:

```lua
require("walkdiff").setup({
  -- How the plugin runs Walkdiff when it starts the app: `<command> app --no-open`. The default
  -- takes the newest release from npm; use "walkdiff" if you installed it yourself.
  command = "npx --yes walkdiff@latest",
  -- The app's data directory, if you start it with --data-dir. Nil means the app's default,
  -- $XDG_DATA_HOME/walkdiff or ~/.local/share/walkdiff.
  data_dir = nil,
  -- Ask for the AI review too when adding a pull request, if the app has one set up.
  ai_review = false,
})
```

## Developing

The tests run in a headless Neovim, with no test plugins:

```sh
nvim --headless -l packages/nvim/tests/run.lua
```

CI runs them on Neovim 0.10.4, the oldest version the plugin supports. A test in `packages/cli` checks the plugin's copies of the API version, report version and analysis steps against the app's.
