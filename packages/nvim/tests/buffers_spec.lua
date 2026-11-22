local buffers = require("walkdiff.buffers")
local names = require("walkdiff.names")
local session = require("walkdiff.session")

local REPORT = {
  files = { { diff = { path = "src/retry.ts", additions = 1, deletions = 1 } } },
  risk = { findings = { { severity = "high", title = "Shell injection", detail = "Quote it.", location = { path = "src/retry.ts", line = 2 } } } },
}
local TEXT = { base = "const retries = 3\nrun()\n", head = "const retries = 5\nrun(input)\n" }

--- Replaces the session's client with one that serves the two sides and the report, and puts the
--- real one back afterwards.
local function with_app(body)
  local real = session.existing
  session.existing = function()
    return {
      file = function(_, _, side)
        return TEXT[side]
      end,
      report = function()
        return REPORT
      end,
    }
  end
  local ok, err = pcall(body)
  session.existing = real
  if not ok then
    error(err, 0)
  end
end

describe("names", function()
  it("names a changed file's side, and reads the name back", function()
    local name = names.changed_file(7, "base", "src/a b/c.ts")
    eq(name, "walkdiff://7/base/src/a b/c.ts")
    eq(names.parse_changed_file(name), { review_id = 7, side = "base", path = "src/a b/c.ts" })
  end)

  it("knows no other name", function()
    eq(names.parse_changed_file("walkdiff://reviews"), nil)
    eq(names.parse_changed_file("walkdiff://7/middle/a.ts"), nil)
  end)
end)

describe("changed file buffers", function()
  it("load each side from the app, read-only, with the file's type and the head's findings", function()
    vim.cmd("source " .. vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)) .. "/../plugin/walkdiff.lua")
    with_app(function()
      buffers.open_diff({ id = 3 }, { path = "src/retry.ts", base_path = "src/retry.ts" }, 2)
      local head = vim.api.nvim_get_current_buf()
      eq(vim.api.nvim_buf_get_name(head), "walkdiff://3/head/src/retry.ts")
      eq(vim.api.nvim_buf_get_lines(head, 0, -1, false), { "const retries = 5", "run(input)" })
      eq({ vim.bo[head].filetype, vim.bo[head].modifiable, vim.bo[head].buftype }, { "typescript", false, "nofile" })
      eq(vim.api.nvim_win_get_cursor(0)[1], 2)
      local diagnostics = vim.diagnostic.get(head, { namespace = buffers.namespace })
      eq({ #diagnostics, diagnostics[1].lnum, diagnostics[1].severity }, { 1, 1, vim.diagnostic.severity.ERROR })
      local windows = vim.api.nvim_tabpage_list_wins(0)
      eq(#windows, 2)
      local base = vim.api.nvim_win_get_buf(windows[1])
      eq(vim.api.nvim_buf_get_lines(base, 0, -1, false), { "const retries = 3", "run()" })
      eq(vim.wo[windows[1]].diff and vim.wo[windows[2]].diff, true)
    end)
  end)

  it("say so in the buffer when the app isn't running", function()
    local real = session.existing
    session.existing = function()
      return nil
    end
    local buffer = vim.api.nvim_create_buf(true, false)
    buffers.read(buffer, "walkdiff://4/head/a.ts")
    session.existing = real
    eq(vim.api.nvim_buf_get_lines(buffer, 0, 1, false)[1]:find("isn't running", 1, true) ~= nil, true)
  end)
end)
