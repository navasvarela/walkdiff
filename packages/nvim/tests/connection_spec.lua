local connection = require("walkdiff.connection")
local errors = require("walkdiff.errors")

local GOOD = { url = "http://127.0.0.1:4317/", apiKey = "k", apiVersion = 1, version = "0.14.0", pid = 42 }

local function with(overrides)
  return vim.json.encode(vim.tbl_extend("force", GOOD, overrides))
end

describe("path", function()
  it("uses the app's default data directory", function()
    eq(connection.path(nil, {}, "/home/me"), "/home/me/.local/share/walkdiff/app.json")
    eq(connection.path("", { XDG_DATA_HOME = "/data" }, "/home/me"), "/data/walkdiff/app.json")
  end)

  it("uses the data directory the user set", function()
    eq(connection.path("  /custom  ", { XDG_DATA_HOME = "/data" }, "/home/me"), "/custom/app.json")
  end)
end)

describe("parse", function()
  it("reads the app's address and key", function()
    eq(connection.parse(vim.json.encode(GOOD)), { url = "http://127.0.0.1:4317/", api_key = "k", api_version = 1, version = "0.14.0" })
    eq(connection.parse(with({ url = "http://localhost:4317" })).url, "http://localhost:4317/")
    eq(connection.parse(with({ url = "http://[::1]:4317/" })).url, "http://[::1]:4317/")
  end)

  for _, case in ipairs({
    { "not JSON", "{", "isn't JSON" },
    { "an address off this machine", with({ url = "http://example.com:4317/" }), "on this machine" },
    { "a look-alike host", with({ url = "http://127.0.0.1.example.com/" }), "on this machine" },
    { "https, which the app never serves", with({ url = "https://127.0.0.1:4317/" }), "on this machine" },
    { "no key", with({ apiKey = "" }), "no key" },
  }) do
    it("refuses a file with " .. case[1], function()
      local parsed, reason = connection.parse(case[2])
      eq(parsed, nil)
      eq(reason ~= nil and reason:find(case[3], 1, true) ~= nil, true)
    end)
  end
end)

describe("read", function()
  it("says the app isn't running when there's no file", function()
    eq(connection.read(vim.fn.tempname()), nil)
  end)

  it("names a file it can't read as a connection file", function()
    local path = vim.fn.tempname()
    vim.fn.writefile({ "{}" }, path)
    local err = raises(function()
      connection.read(path)
    end)
    eq(errors.is(err, errors.kind.user), true)
    vim.fn.delete(path)
  end)
end)
