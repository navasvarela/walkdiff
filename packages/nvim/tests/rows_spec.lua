local rows = require("walkdiff.rows")

local function review(overrides)
  return vim.tbl_extend(
    "force",
    { id = 1, displayName = "acme/app#7", title = "Cap retries", status = "ready", ai = false, unitsToReview = 3, findings = 1, securityLevel = "low" },
    overrides
  )
end

local function finding(path, severity, title)
  return { severity = severity, title = title or path or "whole", location = path and { path = path, line = 3 } or nil }
end

local function report(findings)
  local function file(diff, noise)
    return { diff = vim.tbl_extend("force", { additions = 2, deletions = 1 }, diff), noise = noise }
  end
  return {
    files = {
      file({ status = "modified", path = "pnpm-lock.yaml" }, { kind = "lockfile", reason = "r" }),
      file({ status = "renamed", path = "src/limits.ts", previousPath = "src/caps.ts" }),
      file({ status = "modified", path = "src/retry.ts" }),
    },
    risk = { findings = findings },
  }
end

describe("status_text", function()
  for _, case in ipairs({
    { { status = "queued" }, "Waiting to start" },
    { { status = "analyzing" }, "Analyzing" },
    { { status = "analyzing", step = "tracingCallers" }, "Finding code that uses it (4 of 9)" },
    { { status = "analyzing", step = "reviewingWithAi", ai = true }, "Waiting for the AI review (10 of 10)" },
    { { status = "analyzing", step = "fromTheFuture" }, "Analyzing" },
    { { status = "failed", error = "No such PR" }, "No such PR" },
    { {}, "3 to review · 1 finding" },
    { { securityLevel = "high", findings = 2 }, "3 to review · 2 findings · high security" },
  }) do
    it("describes " .. vim.inspect(case[1], { newline = " ", indent = "" }) .. " as " .. case[2], function()
      eq(rows.status_text(review(case[1])), case[2])
    end)
  end

  it("names a review by its title when it has one", function()
    eq(rows.review_label(review({})), "acme/app#7 Cap retries")
    local untitled = review({})
    untitled.title = nil
    eq(rows.review_label(untitled), "acme/app#7")
  end)
end)

describe("is_analyzing", function()
  it("is true while any review is waiting or running", function()
    eq(rows.is_analyzing({ review({}), review({ status = "queued" }) }), true)
    eq(rows.is_analyzing({ review({}), review({ status = "failed" }) }), false)
  end)
end)

describe("changed_files", function()
  it("keeps the report's order with skippable files last, and gives each file its findings, worst first", function()
    local files = rows.changed_files(report({ finding("src/retry.ts", "low", "a"), finding("src/retry.ts", "high", "b") }))
    eq(
      vim.tbl_map(function(row)
        return { row.path, row.description }
      end, files),
      {
        { "src/limits.ts", "+2 −1 · from src/caps.ts" },
        { "src/retry.ts", "+2 −1 · 2 findings" },
        { "pnpm-lock.yaml", "+2 −1 · lockfile" },
      }
    )
    eq(files[1].base_path, "src/caps.ts")
    eq(
      vim.tbl_map(function(entry)
        return entry.title
      end, files[2].findings),
      { "b", "a" }
    )
  end)
end)

describe("pull_request_findings", function()
  it("collects what no changed file shows", function()
    local found = rows.pull_request_findings(report({ finding(nil, "low"), finding("README.md", "medium"), finding("src/retry.ts", "high") }))
    eq(
      vim.tbl_map(function(entry)
        return entry.title
      end, found),
      { "README.md", "whole" }
    )
  end)
end)
