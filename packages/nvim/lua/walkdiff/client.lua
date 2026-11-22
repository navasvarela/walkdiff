-- Calls a running Walkdiff app's API, described in docs/app-api.md. Each call waits without
-- blocking the editor when made from a task (see async.lua), and synchronously otherwise.
local async = require("walkdiff.async")
local errors = require("walkdiff.errors")
local versions = require("walkdiff.versions")

local M = {}

local UNAUTHORIZED = 401
local NOT_FOUND = 404
local FIRST_ERROR_STATUS = 400
local JSON_OPTIONS = { luanil = { object = true, array = true } }

M.side = { base = "base", head = "head" }

local Client = {}
Client.__index = Client

--- A client for the app a connection points at. `send` is http.send, which tests replace.
function M.new(connection, send)
  return setmetatable({ connection = connection, send = send or require("walkdiff.http").send }, Client)
end

--- Percent-encodes a query value, keeping only the characters URLs never need escaped.
function M.encode(value)
  return (tostring(value):gsub("[^%w%-%._~]", function(char)
    return string.format("%%%02X", char:byte())
  end))
end

local function query(params)
  local parts = {}
  for _, pair in ipairs(params) do
    table.insert(parts, pair[1] .. "=" .. M.encode(pair[2]))
  end
  return table.concat(parts, "&")
end

local function decoded(body)
  local ok, json = pcall(vim.json.decode, body, JSON_OPTIONS)
  if ok then
    return json
  end
  return nil
end

function Client:_request(method, path, body)
  local request = { url = self.connection.url .. path, method = method, api_key = self.connection.api_key, body = body and vim.json.encode(body) }
  local response
  if async.in_task() then
    response = async.await(function(done)
      self.send(request, done)
    end)
  else
    response = self.send(request)
  end
  if response.status == 0 then
    error(errors.gone("The Walkdiff app isn't running."))
  end
  if response.status == UNAUTHORIZED then
    error(errors.gone("The Walkdiff app was restarted."))
  end
  local json = decoded(response.body)
  if response.status >= FIRST_ERROR_STATUS then
    local message = type(json) == "table" and type(json.error) == "string" and json.error or ("The Walkdiff app answered " .. response.status .. ".")
    error(errors.request(response.status, message))
  end
  if json == nil then
    error(errors.request(response.status, "The Walkdiff app's answer wasn't JSON."))
  end
  return json
end

local function version_advice(what, app_speaks, plugin_speaks, app_version)
  local update = app_speaks > plugin_speaks and "Update the Walkdiff Neovim plugin" or "Update Walkdiff (npx walkdiff@latest app)"
  return string.format("The Walkdiff app (%s) uses %s version %d, and this plugin reads version %d. %s.", app_version, what, app_speaks, plugin_speaks, update)
end

--- Checks the app is there and speaks this plugin's API and report versions, saying which side
--- to update when it doesn't.
function Client:check_versions()
  local info = self:_request("GET", "api/info")
  if info.apiVersion ~= versions.api then
    error(errors.version(version_advice("API", info.apiVersion, versions.api, info.version)))
  end
  if info.reportSchemaVersion ~= versions.report_schema then
    error(errors.version(version_advice("report format", info.reportSchemaVersion, versions.report_schema, info.version)))
  end
end

function Client:reviews()
  return self:_request("GET", "api/reviews")
end

function Client:add_review(url, ai)
  return self:_request("POST", "api/reviews", { url = url, ai = ai })
end

function Client:analyze_again(id)
  return self:_request("POST", "api/reviews/" .. id .. "/refresh")
end

function Client:remove(id)
  self:_request("DELETE", "api/reviews/" .. id)
end

function Client:report(id)
  return self:_request("GET", "api/reviews/" .. id .. "/report")
end

--- A changed file's text at one side of the PR; nil when it doesn't exist there, such as an added
--- file at base.
function Client:file(id, side, path)
  local ok, result = pcall(self._request, self, "GET", "api/reviews/" .. id .. "/file?" .. query({ { "side", side }, { "path", path } }))
  if ok then
    return result.text
  end
  if errors.is(result, errors.kind.request) and result.status == NOT_FOUND then
    return nil
  end
  error(result, 0)
end

function Client:open_pull_requests(remote, branch)
  return self:_request("GET", "api/pull-requests?" .. query({ { "remote", remote }, { "branch", branch } }))
end

function Client:review_requests(remote)
  return self:_request("GET", "api/review-requests?" .. query({ { "remote", remote } }))
end

--- The review's report page in the app, for a browser.
function Client:report_page_url(id)
  return self.connection.url .. "reviews/" .. id
end

return M
