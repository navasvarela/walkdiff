-- Runs every tests/*_spec.lua in a headless Neovim, without test plugins:
--   nvim --headless -l packages/nvim/tests/run.lua
-- Specs call the globals `describe`, `it`, `eq` and `raises` this file defines. It exits with 1
-- when any test fails, so CI can run it as it is.
local tests_dir = vim.fs.dirname(vim.fs.normalize(debug.getinfo(1, "S").source:sub(2)))
local plugin_dir = vim.fs.dirname(tests_dir)
vim.opt.runtimepath:prepend(plugin_dir)
package.path = tests_dir .. "/?.lua;" .. package.path

local results = { passed = 0, failed = {} }
local prefix = {}

function describe(name, body)
  table.insert(prefix, name)
  body()
  table.remove(prefix)
end

function it(name, body)
  local full = table.concat(prefix, " ") .. " " .. name
  local ok, err = xpcall(body, debug.traceback)
  if ok then
    results.passed = results.passed + 1
  else
    table.insert(results.failed, { name = full, err = err })
  end
end

function eq(actual, expected)
  if not vim.deep_equal(actual, expected) then
    error("expected " .. vim.inspect(expected) .. "\n     got " .. vim.inspect(actual), 2)
  end
end

--- Asserts `fn` raises, and returns what it raised.
function raises(fn)
  local ok, err = pcall(fn)
  if ok then
    error("expected an error, but none was raised", 2)
  end
  return err
end

local specs = vim.fn.glob(tests_dir .. "/*_spec.lua", false, true)
table.sort(specs)
for _, spec in ipairs(specs) do
  table.insert(prefix, vim.fn.fnamemodify(spec, ":t:r"))
  local ok, err = xpcall(dofile, debug.traceback, spec)
  if not ok then
    table.insert(results.failed, { name = spec, err = err })
  end
  table.remove(prefix)
end

for _, failure in ipairs(results.failed) do
  io.stdout:write("FAIL " .. failure.name .. "\n  " .. tostring(failure.err):gsub("\n", "\n  ") .. "\n")
end
io.stdout:write(string.format("%d passed, %d failed (Neovim %s)\n", results.passed, #results.failed, tostring(vim.version())))
os.exit(#results.failed == 0 and 0 or 1)
