-- The plugin's link to the running Walkdiff app, found from the connection file it writes.
local async = require("walkdiff.async")
local client = require("walkdiff.client")
local connection = require("walkdiff.connection")
local errors = require("walkdiff.errors")

local M = {}

local START_CHOICE = "Start the Walkdiff app"
-- The first run through npx downloads the package and its parsers, which can take a minute or two.
local START_TIMEOUT_MS = 180000
local START_POLL_MS = 500
local TERMINAL_HEIGHT = 10

local current = nil
local terminal_buffer = nil

local function connect()
  local path = connection.path(require("walkdiff").options().data_dir, vim.env, vim.uv.os_homedir())
  local found = connection.read(path)
  if found == nil then
    return nil
  end
  local app = client.new(found)
  -- A file left behind by an app that crashed points at nothing; this raises `gone` then.
  local ok, err = pcall(app.check_versions, app)
  if not ok then
    if errors.is(err, errors.kind.gone) then
      return nil
    end
    error(err, 0)
  end
  return app
end

--- The app's client if it's running, without offering to start it.
function M.existing()
  if current == nil then
    current = connect()
  end
  return current
end

--- Drops the client after the app stopped, so the next call reads the connection file again.
function M.forget()
  current = nil
end

local function is_running(buffer)
  if buffer == nil or not vim.api.nvim_buf_is_valid(buffer) then
    return false
  end
  local job = vim.b[buffer].terminal_job_id
  return job ~= nil and vim.fn.jobwait({ job }, 0)[1] == -1
end

--- Runs the app in a terminal split, where its output stays visible.
local function open_terminal()
  if is_running(terminal_buffer) then
    return
  end
  local command = require("walkdiff").options().command .. " app --no-open"
  local previous = vim.api.nvim_get_current_win()
  vim.cmd("botright " .. TERMINAL_HEIGHT .. "split")
  vim.cmd.terminal(command)
  terminal_buffer = vim.api.nvim_get_current_buf()
  vim.api.nvim_set_current_win(previous)
end

--- Starts the app and waits until it answers. Call from a task.
function M.start()
  local running = M.existing()
  if running ~= nil then
    return running
  end
  open_terminal()
  local deadline = vim.uv.now() + START_TIMEOUT_MS
  while vim.uv.now() < deadline do
    async.sleep(START_POLL_MS)
    local app = M.existing()
    if app ~= nil then
      return app
    end
  end
  error(errors.user("The Walkdiff app didn't start. Its output is in the terminal below."))
end

--- The app's client, offering to start the app when it isn't running. Call from a task.
function M.client()
  local running = M.existing()
  if running ~= nil then
    return running
  end
  local choice = async.await(function(done)
    vim.ui.select({ START_CHOICE }, { prompt = "Reviews run in the Walkdiff app, which isn't running." }, done)
  end)
  if choice ~= START_CHOICE then
    error(errors.cancelled())
  end
  return M.start()
end

return M
