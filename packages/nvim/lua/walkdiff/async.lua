-- Tasks that wait for callbacks without blocking the editor, written as straight-line code:
-- `async.run(function() local x = async.await(start) ... end)`. Code that isn't in a task, such as
-- a BufReadCmd that must fill its buffer before returning, waits synchronously instead.
local M = {}

-- Each running task's error handler. Weak keys, so finished tasks don't stay in memory.
local handlers = setmetatable({}, { __mode = "k" })

local function resume(task, ...)
  local ok, err = coroutine.resume(task, ...)
  if not ok then
    local handler = handlers[task]
    if handler ~= nil then
      handler(err)
    else
      vim.notify(require("walkdiff.errors").message(err), vim.log.levels.ERROR, { title = "Walkdiff" })
    end
  end
end

--- Runs `fn` as a task, sending any error it raises, even after waiting, to `on_error`.
function M.run(fn, on_error)
  local task = coroutine.create(fn)
  handlers[task] = on_error
  resume(task)
end

--- Whether the caller is in a task, and so can wait without blocking the editor.
function M.in_task()
  local task, is_main = coroutine.running()
  return task ~= nil and not is_main and handlers[task] ~= nil
end

--- Calls `start(callback)` and waits for the callback, returning what it was called with.
--- The task resumes on the main loop, where every editor API can be used.
function M.await(start)
  local task = coroutine.running()
  start(function(...)
    local args = { n = select("#", ...), ... }
    vim.schedule(function()
      resume(task, unpack(args, 1, args.n))
    end)
  end)
  return coroutine.yield()
end

function M.sleep(ms)
  M.await(function(done)
    vim.defer_fn(done, ms)
  end)
end

return M
