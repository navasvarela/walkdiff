-- What the reviews list shows for reviews, changed files and findings, apart from how the buffer
-- draws it. The VS Code extension's reviewRows.ts does the same for its view.
local M = {}

M.status = { queued = "queued", analyzing = "analyzing", ready = "ready", failed = "failed" }

-- The analysis steps in the order they run, with their labels, as review-model's analysisSteps.ts
-- has them. A step this list doesn't know, from a newer app, shows as plain "Analyzing".
local STEPS = {
  { id = "fetchingPullRequest", label = "Fetching the pull request" },
  { id = "fetchingCommits", label = "Fetching its commits" },
  { id = "readingChanges", label = "Reading the changed code" },
  { id = "tracingCallers", label = "Finding code that uses it" },
  { id = "checkingDependencies", label = "Checking dependencies" },
  { id = "scanningCode", label = "Scanning for security problems" },
  { id = "checkingQuality", label = "Checking code quality" },
  { id = "checkingBreakingChanges", label = "Looking for breaking changes" },
  { id = "findingCoverage", label = "Looking for test coverage" },
  { id = "reviewingWithAi", label = "Waiting for the AI review" },
}
local AI_STEP = "reviewingWithAi"

local SEVERITY_RANK = { high = 1, medium = 2, low = 3 }
-- A severity from a newer app sorts after the ones this plugin knows.
local UNKNOWN_SEVERITY_RANK = 4
local LOW = "low"

local function count(value, noun)
  return value .. " " .. noun .. (value == 1 and "" or "s")
end

--- The parts that are there, joined. Parts come as arguments, not a table, as a table with nil
--- holes has no reliable length or order.
local function compact(separator, ...)
  local kept = {}
  for index = 1, select("#", ...) do
    local part = select(index, ...)
    if part ~= nil and part ~= false then
      table.insert(kept, part)
    end
  end
  return table.concat(kept, separator)
end

local function step_text(step, ai)
  local number = 0
  for _, candidate in ipairs(STEPS) do
    if ai or candidate.id ~= AI_STEP then
      number = number + 1
    end
    if candidate.id == step then
      return string.format("%s (%d of %d)", candidate.label, number, ai and #STEPS or #STEPS - 1)
    end
  end
  return "Analyzing"
end

local function ready_text(review)
  local security = review.securityLevel
  return compact(
    " · ",
    review.unitsToReview and (review.unitsToReview .. " to review"),
    review.findings and count(review.findings, "finding"),
    security and security ~= LOW and (security .. " security")
  )
end

--- What a review's status says: its progress, its counts, or why it failed.
function M.status_text(review)
  if review.status == M.status.queued then
    return "Waiting to start"
  elseif review.status == M.status.analyzing then
    return review.step and step_text(review.step, review.ai == true) or "Analyzing"
  elseif review.status == M.status.failed then
    return review.error or "Failed"
  end
  return ready_text(review)
end

function M.review_label(review)
  return review.title and (review.displayName .. " " .. review.title) or review.displayName
end

--- Whether any review is still being analyzed, so the list is worth reading again soon.
function M.is_analyzing(reviews)
  for _, review in ipairs(reviews) do
    if review.status == M.status.queued or review.status == M.status.analyzing then
      return true
    end
  end
  return false
end

local function by_severity(findings)
  local sorted = vim.list_slice(findings)
  table.sort(sorted, function(a, b)
    return (SEVERITY_RANK[a.severity] or UNKNOWN_SEVERITY_RANK) < (SEVERITY_RANK[b.severity] or UNKNOWN_SEVERITY_RANK)
  end)
  return sorted
end

local function findings_in(report, path)
  local found = {}
  for _, finding in ipairs(report.risk.findings) do
    if finding.location ~= nil and finding.location.path == path then
      table.insert(found, finding)
    end
  end
  return by_severity(found)
end

--- The report's changed files in its own order, as git lists them, with the files a reviewer can
--- usually skip (lockfiles, generated and vendored files) after the rest.
function M.changed_files(report)
  local kept, skippable = {}, {}
  for _, file in ipairs(report.files) do
    local diff = file.diff
    local base_path = diff.previousPath or diff.path
    local findings = findings_in(report, diff.path)
    local description = compact(
      " · ",
      "+" .. diff.additions .. " −" .. diff.deletions,
      base_path ~= diff.path and ("from " .. base_path),
      file.noise and file.noise.kind,
      #findings > 0 and count(#findings, "finding")
    )
    local row = { path = diff.path, base_path = base_path, description = description, findings = findings, is_noise = file.noise ~= nil }
    table.insert(row.is_noise and skippable or kept, row)
  end
  return vim.list_extend(kept, skippable)
end

--- Findings about the PR as a whole, or about files it doesn't change, which no file row shows.
function M.pull_request_findings(report)
  local changed = {}
  for _, file in ipairs(report.files) do
    changed[file.diff.path] = true
  end
  local found = {}
  for _, finding in ipairs(report.risk.findings) do
    if finding.location == nil or not changed[finding.location.path] then
      table.insert(found, finding)
    end
  end
  return by_severity(found)
end

function M.finding_label(finding)
  return finding.severity .. ": " .. finding.title
end

return M
