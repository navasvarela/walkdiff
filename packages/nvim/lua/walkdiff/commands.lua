-- `:Walkdiff <subcommand>`. Each runs as a task, so waiting on the app or a lookup on GitHub or
-- GitLab never blocks the editor, and reports its failures to the user.
local async = require("walkdiff.async")
local errors = require("walkdiff.errors")
local git = require("walkdiff.git")
local names = require("walkdiff.names")
local reports = require("walkdiff.reports")
local rows = require("walkdiff.rows")
local session = require("walkdiff.session")

local M = {}

local START_AGAIN_CHOICE = "Start the Walkdiff app"
local QUICKFIX_TYPES = { high = "E", medium = "W", low = "I" }

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = "Walkdiff" })
end

local function select(items, opts)
  local choice = async.await(function(done)
    vim.ui.select(items, opts, done)
  end)
  if choice == nil then
    error(errors.cancelled())
  end
  return choice
end

local function input(opts)
  local value = async.await(function(done)
    vim.ui.input(opts, done)
  end)
  if value == nil or vim.trim(value) == "" then
    error(errors.cancelled())
  end
  return vim.trim(value)
end

local run_task

local function on_failure(err)
  if errors.is(err, errors.kind.cancelled) then
    return
  end
  if errors.is(err, errors.kind.gone) then
    session.forget()
    run_task(function()
      select({ START_AGAIN_CHOICE }, { prompt = err.message })
      session.start()
      require("walkdiff.reviews").render()
    end)
    return
  end
  notify(errors.message(err), vim.log.levels.ERROR)
end

run_task = function(fn)
  async.run(fn, on_failure)
end

local function pick_pull_request(listings, prompt)
  return select(listings, {
    prompt = prompt,
    format_item = function(listing)
      return string.format("%s %s (%s%s)", listing.displayName, listing.title, listing.author, listing.draft and ", draft" or "")
    end,
  })
end

local function add(url)
  local review = session.client():add_review(url, require("walkdiff").options().ai_review == true)
  require("walkdiff.reviews").open()
  notify("Walkdiff is analyzing " .. review.displayName .. ".")
end

--- The review a command is about: the one under the cursor in the list, the one whose file is
--- open, or the one the user picks.
local function review_in_context(app, wanted)
  local item = require("walkdiff.reviews").item_at_cursor()
  if item ~= nil then
    return item.review
  end
  local reviews = app:reviews()
  local file = names.parse_changed_file(vim.api.nvim_buf_get_name(0))
  for _, review in ipairs(reviews) do
    if file ~= nil and review.id == file.review_id then
      return review
    end
  end
  local candidates = vim.tbl_filter(wanted or function()
    return true
  end, reviews)
  if #candidates == 0 then
    error(errors.user("There's no review for that yet."))
  end
  return select(candidates, { prompt = "Which review?", format_item = rows.review_label })
end

local function is_ready(review)
  return review.hasReport == true
end

local function findings_quickfix(review, report)
  local changed = {}
  for _, file in ipairs(report.files) do
    changed[file.diff.path] = true
  end
  local entries = {}
  for _, finding in ipairs(report.risk.findings) do
    local entry = { text = rows.finding_label(finding) .. ": " .. (vim.split(finding.detail, "\n")[1] or ""), type = QUICKFIX_TYPES[finding.severity] or "I" }
    if finding.location ~= nil and changed[finding.location.path] then
      entry.filename = names.changed_file(review.id, "head", finding.location.path)
      entry.lnum = finding.location.line or 1
    elseif finding.location ~= nil then
      entry.text = finding.location.path .. ": " .. entry.text
    end
    table.insert(entries, entry)
  end
  return entries
end

local SUBCOMMANDS = {
  list = function()
    require("walkdiff.reviews").open()
  end,
  refresh = function()
    require("walkdiff.reviews").render()
  end,
  start = function()
    session.start()
    require("walkdiff.reviews").render()
  end,
  branch = function()
    local branch = git.current_host_branch()
    local open = session.client():open_pull_requests(branch.remote_url, branch.branch)
    if #open == 0 then
      notify("There's no open pull request from " .. branch.branch .. ". Push it and open one, or review another.")
      return
    end
    add((#open == 1 and open[1] or pick_pull_request(open, "Pull requests from " .. branch.branch)).url)
  end,
  requests = function()
    local branch = git.current_host_branch()
    local waiting = session.client():review_requests(branch.remote_url)
    if #waiting == 0 then
      notify("No open pull requests are waiting for your review.")
      return
    end
    add(pick_pull_request(waiting, "Pull requests waiting for your review").url)
  end,
  link = function(args)
    add(args[1] or input({ prompt = "Pull request or merge request link: " }))
  end,
  report = function()
    local app = session.client()
    local review = review_in_context(app, is_ready)
    local _, err = vim.ui.open(app:report_page_url(review.id))
    if err ~= nil then
      error(errors.user("Walkdiff couldn't open the report: " .. err))
    end
  end,
  findings = function()
    local app = session.client()
    local review = review_in_context(app, is_ready)
    local report = reports.get(app, review)
    vim.fn.setqflist({}, " ", { title = "Walkdiff findings: " .. review.displayName, items = findings_quickfix(review, report) })
    vim.cmd.copen()
  end,
  again = function()
    local app = session.client()
    app:analyze_again(review_in_context(app).id)
    require("walkdiff.reviews").render()
  end,
  remove = function()
    local app = session.client()
    app:remove(review_in_context(app).id)
    require("walkdiff.reviews").render()
  end,
}

--- Runs `:Walkdiff` with its arguments; with none, opens the reviews list.
function M.run(args)
  local name = args[1] or "list"
  local subcommand = SUBCOMMANDS[name]
  if subcommand == nil then
    notify("Unknown subcommand " .. name .. ". Try one of: " .. table.concat(M.complete(""), ", "), vim.log.levels.ERROR)
    return
  end
  run_task(function()
    subcommand(vim.list_slice(args, 2))
  end)
end

function M.complete(lead)
  local matches = {}
  for name in pairs(SUBCOMMANDS) do
    if vim.startswith(name, lead) then
      table.insert(matches, name)
    end
  end
  table.sort(matches)
  return matches
end

--- What a test can check without a running editor session: the quickfix entries for findings.
M._findings_quickfix = findings_quickfix

return M
