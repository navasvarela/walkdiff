-- Walkdiff for Neovim: reviews pull requests and merge requests with the Walkdiff app running on
-- this machine. `require("walkdiff").setup({ ... })` is optional; the commands work without it.
local M = {}

M.defaults = {
  -- How to run Walkdiff when the plugin starts the app: `<command> app --no-open`.
  -- The newest release, without npx asking first: npx would otherwise reuse one it has cached.
  command = "npx --yes walkdiff@latest",
  -- The app's data directory, if it's started with `--data-dir`. Nil means the app's default.
  data_dir = nil,
  -- Ask for the AI review too when adding a pull request, if the app has one set up.
  ai_review = false,
}

local options = vim.deepcopy(M.defaults)

function M.setup(opts)
  options = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
end

function M.options()
  return options
end

return M
