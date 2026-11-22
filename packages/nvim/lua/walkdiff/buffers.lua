-- Loading the plugin's buffers, and showing findings in them.
local errors = require("walkdiff.errors")
local names = require("walkdiff.names")
local reports = require("walkdiff.reports")
local session = require("walkdiff.session")

local M = {}

M.namespace = vim.api.nvim_create_namespace("walkdiff")

local SEVERITIES = {
  high = vim.diagnostic.severity.ERROR,
  medium = vim.diagnostic.severity.WARN,
  low = vim.diagnostic.severity.INFO,
}

local function fill(buffer, lines)
  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].modified = false
end

local function lines_of(text)
  local lines = vim.split(text, "\n", { plain = true })
  -- A file ending in a newline would otherwise get an empty last line.
  if lines[#lines] == "" then
    table.remove(lines)
  end
  return lines
end

--- Shows the review's findings in a file at the PR's head as diagnostics on their lines.
function M.show_findings(buffer, report, path)
  local diagnostics = {}
  for _, finding in ipairs(report.risk.findings) do
    if finding.location ~= nil and finding.location.path == path then
      table.insert(diagnostics, {
        lnum = math.max((finding.location.line or 1) - 1, 0),
        col = 0,
        severity = SEVERITIES[finding.severity] or vim.diagnostic.severity.HINT,
        message = finding.title .. "\n" .. finding.detail,
        source = "walkdiff",
      })
    end
  end
  vim.diagnostic.set(M.namespace, buffer, diagnostics)
end

--- Fills a changed file's buffer from the app. A BufReadCmd has to fill the buffer before it
--- returns, so this waits for the app rather than running as a task.
local function read_changed_file(buffer, file)
  vim.bo[buffer].buftype = "nofile"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].bufhidden = "hide"
  local app = session.existing()
  if app == nil then
    fill(buffer, { "The Walkdiff app isn't running. Start it with :Walkdiff start, then reload this buffer with :edit." })
    return
  end
  fill(buffer, lines_of(app:file(file.review_id, file.side, file.path) or ""))
  vim.bo[buffer].readonly = true
  local filetype = vim.filetype.match({ filename = file.path, buf = buffer })
  if filetype ~= nil then
    vim.bo[buffer].filetype = filetype
  end
  if file.side == "head" then
    M.show_findings(buffer, reports.get(app, { id = file.review_id }), file.path)
  end
end

--- The BufReadCmd for `walkdiff://` names.
function M.read(buffer, name)
  if name == names.REVIEWS then
    require("walkdiff.reviews").attach(buffer)
    return
  end
  local file = names.parse_changed_file(name)
  if file == nil then
    return
  end
  local ok, err = pcall(read_changed_file, buffer, file)
  if not ok then
    if errors.is(err, errors.kind.gone) then
      session.forget()
    end
    fill(buffer, { "Walkdiff couldn't read this file: " .. errors.message(err) })
  end
end

--- Opens a changed file's base and head side by side in diff mode, in a new tab, at a line of
--- the head when one is given.
function M.open_diff(review, row, line)
  vim.cmd.tabedit(vim.fn.fnameescape(names.changed_file(review.id, "head", row.path)))
  local head_window = vim.api.nvim_get_current_win()
  vim.cmd("leftabove vertical diffsplit " .. vim.fn.fnameescape(names.changed_file(review.id, "base", row.base_path)))
  vim.api.nvim_set_current_win(head_window)
  if line ~= nil then
    local last = vim.api.nvim_buf_line_count(0)
    vim.api.nvim_win_set_cursor(head_window, { math.min(math.max(line, 1), last), 0 })
    vim.cmd("normal! zz")
  end
end

return M
