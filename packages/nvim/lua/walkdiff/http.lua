-- Requests to the app through curl, which Neovim has no built-in replacement for.
local M = {}

-- Long enough for a report of several megabytes, or a lookup the app makes on GitHub or GitLab.
local TIMEOUT_SECONDS = 60
-- What curl's --write-out appends after the body, so the status can be told apart from it.
local STATUS_SEPARATOR = "\n"
-- The status given when nothing answered: curl couldn't connect, or gave up waiting.
local NOTHING_ANSWERED = 0

-- A string in curl's config syntax, inside which backslash escapes apply.
local function quoted(value)
  local escaped = value:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r")
  return '"' .. escaped .. '"'
end

--- The request as a curl config. It goes to curl on stdin, never in its arguments, so the API key
--- doesn't show in the process list, where any user on the machine could read it.
function M.config(request)
  local lines = {
    "url = " .. quoted(request.url),
    "request = " .. quoted(request.method),
    "header = " .. quoted("x-walkdiff-key: " .. request.api_key),
  }
  if request.body ~= nil then
    table.insert(lines, "header = " .. quoted("Content-Type: application/json"))
    table.insert(lines, "data-binary = " .. quoted(request.body))
  end
  return table.concat(lines, "\n") .. "\n"
end

-- `--noproxy '*'`, so a proxy set in the environment never receives a request meant for this machine.
local COMMAND =
  { "curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", tostring(TIMEOUT_SECONDS), "--write-out", STATUS_SEPARATOR .. "%{http_code}", "--config", "-" }

--- The response from curl's output: the body, then the status on the last line. Status 0 means
--- nothing answered, as when the app isn't running.
function M.parse(result)
  if result.code ~= 0 then
    return { status = NOTHING_ANSWERED, body = "", error = vim.trim(result.stderr or "") }
  end
  local stdout = result.stdout or ""
  local body, status = stdout:match("^(.*)\n(%d%d%d)$")
  return { status = tonumber(status) or NOTHING_ANSWERED, body = body or "" }
end

local function start(request, on_exit)
  local ok, process = pcall(vim.system, COMMAND, { stdin = M.config(request), text = true }, on_exit)
  if not ok then
    error(require("walkdiff.errors").user("Walkdiff needs curl to talk to the app: " .. tostring(process)))
  end
  return process
end

--- Sends a request to the app. With `done`, calls it with the response; without, waits and
--- returns it.
function M.send(request, done)
  if done == nil then
    return M.parse(start(request, nil):wait())
  end
  start(request, function(result)
    done(M.parse(result))
  end)
end

return M
