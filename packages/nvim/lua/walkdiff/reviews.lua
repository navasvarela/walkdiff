-- The reviews list: the app's reviews with their progress. A finished review opens onto its
-- changed files and findings, and a file opens in a diff tab.
local async = require("walkdiff.async")
local buffers = require("walkdiff.buffers")
local errors = require("walkdiff.errors")
local names = require("walkdiff.names")
local reports = require("walkdiff.reports")
local rows = require("walkdiff.rows")
local session = require("walkdiff.session")

local M = {}

-- Analyses take from seconds to minutes; reading the list every couple of seconds keeps the step
-- shown current.
local POLL_MS = 2000
local WIDTH = 72
local HEADER = {
  "Walkdiff reviews",
  "<CR> open · o report · a analyze again · D remove · r refresh · s start the app · q close",
  "",
}
local NOT_RUNNING = {
  "The Walkdiff app isn't running. Press s to start it, or add a review with",
  ":Walkdiff branch, :Walkdiff requests or :Walkdiff link <url>.",
}
local NONE_YET = { "No reviews yet. Add one with :Walkdiff branch, :Walkdiff requests or :Walkdiff link <url>." }

local SECURITY_MARKERS = { high = "!!", medium = "! " }
local STATUS_MARKERS = { queued = "· ", analyzing = "… ", failed = "✗ " }
local READY_MARKER = "✓ "

local state = { buffer = nil, items = {}, expanded = {}, statuses = {}, polling = false }

local function marker(review)
  if review.status == rows.status.ready then
    return SECURITY_MARKERS[review.securityLevel] or READY_MARKER
  end
  return STATUS_MARKERS[review.status] or "  "
end

local function is_shown()
  return state.buffer ~= nil and vim.api.nvim_buf_is_valid(state.buffer) and vim.fn.bufwinid(state.buffer) ~= -1
end

--- Tells the user when an analysis they're waiting for finishes.
local function announce_ready(reviews)
  local previous = state.statuses
  state.statuses = {}
  for _, review in ipairs(reviews) do
    state.statuses[review.id] = review.status
    local was = previous[review.id]
    if review.status == rows.status.ready and (was == rows.status.queued or was == rows.status.analyzing) then
      vim.notify(review.displayName .. " is ready to review. Open it from :Walkdiff list.", vim.log.levels.INFO, { title = "Walkdiff" })
    end
  end
end

local function add(lines, items, text, item)
  table.insert(lines, text)
  items[#lines] = item
end

local function add_review_contents(lines, items, app, review)
  local report = reports.get(app, review)
  local whole = rows.pull_request_findings(report)
  if #whole > 0 then
    add(lines, items, "    Whole pull request", nil)
    for _, finding in ipairs(whole) do
      add(lines, items, "      " .. rows.finding_label(finding), { kind = "finding", review = review, finding = finding })
    end
  end
  for _, row in ipairs(rows.changed_files(report)) do
    add(lines, items, string.format("    %s  %s", row.path, row.description), { kind = "file", review = review, row = row })
    for _, finding in ipairs(row.findings) do
      local line = finding.location and finding.location.line
      add(lines, items, "      " .. rows.finding_label(finding) .. (line and (" :" .. line) or ""), { kind = "finding", review = review, row = row, finding = finding })
    end
  end
end

--- The list's lines, and what each line stands for.
local function build(app)
  local lines, items = vim.list_slice(HEADER), {}
  if app == nil then
    vim.list_extend(lines, NOT_RUNNING)
    return lines, items, false
  end
  local reviews = app:reviews()
  announce_ready(reviews)
  if #reviews == 0 then
    vim.list_extend(lines, NONE_YET)
  end
  for _, review in ipairs(reviews) do
    add(lines, items, marker(review) .. rows.review_label(review) .. "  " .. rows.status_text(review), { kind = "review", review = review })
    if state.expanded[review.id] and review.hasReport then
      add_review_contents(lines, items, app, review)
    end
  end
  return lines, items, rows.is_analyzing(reviews)
end

local function show(lines)
  if state.buffer == nil or not vim.api.nvim_buf_is_valid(state.buffer) then
    return
  end
  vim.bo[state.buffer].modifiable = true
  vim.api.nvim_buf_set_lines(state.buffer, 0, -1, false, lines)
  vim.bo[state.buffer].modifiable = false
  vim.bo[state.buffer].modified = false
end

local function poll_later()
  if state.polling then
    return
  end
  state.polling = true
  vim.defer_fn(function()
    state.polling = false
    if is_shown() then
      M.render()
    end
  end, POLL_MS)
end

--- Reads the reviews again and redraws the list.
function M.render()
  async.run(function()
    local lines, items, analyzing = build(session.existing())
    state.items = items
    show(lines)
    if analyzing then
      poll_later()
    end
  end, function(err)
    if errors.is(err, errors.kind.gone) then
      session.forget()
      show(vim.list_extend(vim.list_slice(HEADER), NOT_RUNNING))
      return
    end
    vim.notify(errors.message(err), vim.log.levels.ERROR, { title = "Walkdiff" })
  end)
end

--- The item on the cursor's line, when the cursor is in the list.
function M.item_at_cursor()
  if vim.api.nvim_get_current_buf() ~= state.buffer then
    return nil
  end
  return state.items[vim.api.nvim_win_get_cursor(0)[1]]
end

local function activate()
  local item = M.item_at_cursor()
  if item == nil then
    return
  end
  if item.kind == "review" then
    if item.review.hasReport then
      state.expanded[item.review.id] = not state.expanded[item.review.id]
      M.render()
    else
      vim.notify(rows.review_label(item.review) .. ": " .. rows.status_text(item.review), vim.log.levels.INFO, { title = "Walkdiff" })
    end
  elseif item.kind == "file" then
    buffers.open_diff(item.review, item.row, nil)
  elseif item.row ~= nil then
    buffers.open_diff(item.review, item.row, item.finding.location and item.finding.location.line)
  else
    vim.notify(item.finding.title .. "\n\n" .. item.finding.detail, vim.log.levels.INFO, { title = "Walkdiff" })
  end
end

local function map(lhs, rhs, desc)
  vim.keymap.set("n", lhs, rhs, { buffer = state.buffer, nowait = true, silent = true, desc = desc })
end

--- Sets up a buffer named `walkdiff://reviews` as the list. Called by its BufReadCmd.
function M.attach(buffer)
  state.buffer = buffer
  vim.bo[buffer].buftype = "nofile"
  vim.bo[buffer].bufhidden = "hide"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].filetype = "walkdiff"
  local commands = require("walkdiff.commands")
  map("<CR>", activate, "Open the review, file or finding")
  map("o", function()
    commands.run({ "report" })
  end, "Open the report in the browser")
  map("a", function()
    commands.run({ "again" })
  end, "Analyze the review again")
  map("D", function()
    commands.run({ "remove" })
  end, "Remove the review from the list")
  map("r", M.render, "Refresh the list")
  map("s", function()
    commands.run({ "start" })
  end, "Start the Walkdiff app")
  map("q", "<Cmd>close<CR>", "Close the list")
  M.render()
end

--- Shows the list in a window on the left, reusing the one it's already in.
function M.open()
  if is_shown() then
    vim.api.nvim_set_current_win(vim.fn.bufwinid(state.buffer))
    M.render()
    return
  end
  vim.cmd("topleft vertical " .. WIDTH .. "split")
  if state.buffer ~= nil and vim.api.nvim_buf_is_valid(state.buffer) then
    vim.api.nvim_win_set_buf(0, state.buffer)
    M.render()
  else
    vim.cmd.edit(vim.fn.fnameescape(names.REVIEWS))
  end
end

return M
