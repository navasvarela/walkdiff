local commands = require("walkdiff.commands")

describe("complete", function()
  it("completes subcommands", function()
    eq(commands.complete("re"), { "refresh", "remove", "report", "requests" })
    eq(#commands.complete("") >= 10, true)
  end)
end)

describe("findings in the quickfix list", function()
  it("points findings in changed files at their head buffer, and names other files in the text", function()
    local report = {
      files = { { diff = { path = "src/retry.ts" } } },
      risk = {
        findings = {
          { severity = "high", title = "Shell injection", detail = "Quote it.\nMore.", location = { path = "src/retry.ts", line = 4 } },
          { severity = "medium", title = "Docs drift", detail = "Update it.", location = { path = "README.md", line = 1 } },
          { severity = "low", title = "Large PR", detail = "Split it." },
        },
      },
    }
    eq(commands._findings_quickfix({ id = 3 }, report), {
      { filename = "walkdiff://3/head/src/retry.ts", lnum = 4, text = "high: Shell injection: Quote it.", type = "E" },
      { text = "README.md: medium: Docs drift: Update it.", type = "W" },
      { text = "low: Large PR: Split it.", type = "I" },
    })
  end)
end)
