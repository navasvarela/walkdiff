local async = require("walkdiff.async")
local client = require("walkdiff.client")
local errors = require("walkdiff.errors")
local http = require("walkdiff.http")
local versions = require("walkdiff.versions")

local CONNECTION = { url = "http://127.0.0.1:4317/", api_key = "secret", api_version = 1, version = "0.14.0" }

--- A stand-in for http.send that answers every request with `status` and `body`, and records
--- what was sent. It calls back at once, as curl would later.
local function answering(status, body, sent)
  return function(request, done)
    table.insert(sent or {}, request)
    local response = { status = status, body = type(body) == "string" and body or vim.json.encode(body) }
    if done == nil then
      return response
    end
    done(response)
  end
end

describe("http", function()
  it("puts the key in curl's config, escaped, never in its arguments", function()
    local config = http.config({ url = "http://127.0.0.1:4317/api/reviews", method = "POST", api_key = 'k"e\\y', body = '{"url":"a\\"b"}' })
    eq(
      config,
      table.concat({
        'url = "http://127.0.0.1:4317/api/reviews"',
        'request = "POST"',
        'header = "x-walkdiff-key: k\\"e\\\\y"',
        'header = "Content-Type: application/json"',
        'data-binary = "{\\"url\\":\\"a\\\\\\"b\\"}"',
        "",
      }, "\n")
    )
  end)

  it("reads the status curl writes after the body", function()
    eq(http.parse({ code = 0, stdout = '{"a":1}\n200' }), { status = 200, body = '{"a":1}' })
    eq(http.parse({ code = 0, stdout = "\n404" }), { status = 404, body = "" })
    eq(http.parse({ code = 7, stdout = "", stderr = "Failed to connect\n" }), { status = 0, body = "", error = "Failed to connect" })
  end)
end)

describe("requests", function()
  it("sends the key and query to the app's address", function()
    local sent = {}
    local app = client.new(CONNECTION, answering(200, {}, sent))
    app:open_pull_requests("git@github.com:acme/app.git", "fix/retries")
    eq(sent[1].url, "http://127.0.0.1:4317/api/pull-requests?remote=git%40github.com%3Aacme%2Fapp.git&branch=fix%2Fretries")
    eq(sent[1].api_key, "secret")
    eq(sent[1].method, "GET")
  end)

  it("posts a review as JSON", function()
    local sent = {}
    client.new(CONNECTION, answering(202, { id = 3 }, sent)):add_review("https://github.com/acme/app/pull/7", false)
    eq(sent[1].method, "POST")
    eq(vim.json.decode(sent[1].body), { url = "https://github.com/acme/app/pull/7", ai = false })
  end)

  it("reads JSON nulls as nil", function()
    local reviews = client.new(CONNECTION, answering(200, '[{"id":1,"title":null}]')):reviews()
    eq(reviews, { { id = 1 } })
  end)

  it("passes on the app's own error message", function()
    local err = raises(function()
      client.new(CONNECTION, answering(403, { error = "Walkdiff needs your GitHub login." })):review_requests("git@github.com:acme/app.git")
    end)
    eq({ err.kind, err.status, err.message }, { errors.kind.request, 403, "Walkdiff needs your GitHub login." })
  end)

  it("reads a file missing at one side as absent", function()
    eq(client.new(CONNECTION, answering(404, { error = "No such file" })):file(1, "base", "src/new.ts"), nil)
    eq(client.new(CONNECTION, answering(200, { text = "hi\n" })):file(1, "head", "a"), "hi\n")
  end)

  it("tells a stopped or restarted app apart from an error", function()
    for _, status in ipairs({ 0, 401 }) do
      local err = raises(function()
        client.new(CONNECTION, answering(status, "")):reviews()
      end)
      eq(errors.is(err, errors.kind.gone), true)
    end
  end)

  it("links to a review's report page", function()
    eq(client.new(CONNECTION, answering(200, {})):report_page_url(3), "http://127.0.0.1:4317/reviews/3")
  end)
end)

describe("versions", function()
  it("accepts the versions it was written for", function()
    client.new(CONNECTION, answering(200, { apiVersion = versions.api, reportSchemaVersion = versions.report_schema, version = "0.14.0" })):check_versions()
  end)

  it("says which side to update", function()
    local newer_api = raises(function()
      client.new(CONNECTION, answering(200, { apiVersion = versions.api + 1, reportSchemaVersion = versions.report_schema, version = "1.0.0" })):check_versions()
    end)
    eq(newer_api.kind, errors.kind.version)
    eq(newer_api.message:find("Update the Walkdiff Neovim plugin", 1, true) ~= nil, true)
    local older_report = raises(function()
      client.new(CONNECTION, answering(200, { apiVersion = versions.api, reportSchemaVersion = versions.report_schema - 1, version = "0.13.0" })):check_versions()
    end)
    eq(older_report.message:find("npx walkdiff@latest app", 1, true) ~= nil, true)
  end)
end)

describe("waiting in a task", function()
  it("waits for the answer without blocking, then carries on", function()
    local got
    async.run(function()
      got = client.new(CONNECTION, answering(200, { { id = 9 } })):reviews()
    end)
    vim.wait(1000, function()
      return got ~= nil
    end)
    eq(got, { { id = 9 } })
  end)

  it("sends an error raised after waiting to the task's handler", function()
    local caught
    async.run(function()
      client.new(CONNECTION, answering(0, "")):reviews()
    end, function(err)
      caught = err
    end)
    vim.wait(1000, function()
      return caught ~= nil
    end)
    eq(caught.kind, errors.kind.gone)
  end)
end)
