-- Finding the running app from the connection file it writes, described in docs/app-api.md.
local M = {}

M.FILE = "app.json"

-- The app only listens on loopback. Refusing any other address keeps the key, and whatever the
-- plugin sends, on this machine even if something else wrote the file.
local LOOPBACK_HOSTS = { ["127.0.0.1"] = true, ["localhost"] = true, ["[::1]"] = true }

local function non_empty(value)
  if type(value) ~= "string" or vim.trim(value) == "" then
    return nil
  end
  return vim.trim(value)
end

--- Where the app writes its connection file: the `data_dir` setting, or the app's own default,
--- `$XDG_DATA_HOME/walkdiff` or `~/.local/share/walkdiff`.
function M.path(data_dir, env, home)
  local dir = non_empty(data_dir)
  if dir == nil then
    local data_home = non_empty(env.XDG_DATA_HOME) or (home .. "/.local/share")
    dir = data_home .. "/walkdiff"
  end
  return vim.fs.normalize(dir) .. "/" .. M.FILE
end

local function is_loopback_http(url)
  if type(url) ~= "string" then
    return false
  end
  local host = url:match("^http://(%[[^%]]+%])[:/]") or url:match("^http://([^:/]+)[:/]")
  return host ~= nil and LOOPBACK_HOSTS[host] == true
end

--- The app's address and key from the file's text; nil and why when it isn't a connection file.
function M.parse(text)
  local ok, decoded = pcall(vim.json.decode, text)
  if not ok or type(decoded) ~= "table" then
    return nil, "isn't JSON"
  end
  if not is_loopback_http(decoded.url) then
    return nil, "doesn't point at an app on this machine"
  end
  if non_empty(decoded.apiKey) == nil then
    return nil, "has no key"
  end
  if type(decoded.apiVersion) ~= "number" then
    return nil, "has no API version"
  end
  local url = decoded.url:sub(-1) == "/" and decoded.url or (decoded.url .. "/")
  return { url = url, api_key = decoded.apiKey, api_version = decoded.apiVersion, version = tostring(decoded.version or "") }
end

--- The running app's connection; nil when the file isn't there, as the app isn't running.
--- Raises a user error when the file is there but isn't one the app wrote.
function M.read(path)
  local file = io.open(path, "r")
  if file == nil then
    return nil
  end
  local text = file:read("*a")
  file:close()
  local connection, reason = M.parse(text)
  if connection == nil then
    error(require("walkdiff.errors").user(path .. " isn't a Walkdiff app connection file: it " .. reason .. "."))
  end
  return connection
end

return M
