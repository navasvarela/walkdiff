-- Failures the plugin tells apart. Each is a table raised with `error`, so a command can show the
-- message as it is, and react to the kind: offer to start the app when it's gone, say nothing when
-- the user cancelled.
local M = {}

M.kind = {
  -- The app stopped, or restarted with a new key: the connection file has to be read again.
  gone = "gone",
  -- The app answered with an error, whose message is written to be shown as it is.
  request = "request",
  -- The app and the plugin speak different versions of the API or the report.
  version = "version",
  -- Something the user can fix, explained in the message.
  user = "user",
  -- The user backed out of a prompt.
  cancelled = "cancelled",
}

local function failure(kind, message, status)
  return { walkdiff = true, kind = kind, message = message, status = status }
end

function M.gone(message)
  return failure(M.kind.gone, message)
end

function M.request(status, message)
  return failure(M.kind.request, message, status)
end

function M.version(message)
  return failure(M.kind.version, message)
end

function M.user(message)
  return failure(M.kind.user, message)
end

function M.cancelled()
  return failure(M.kind.cancelled, "Cancelled")
end

function M.is(err, kind)
  return type(err) == "table" and err.walkdiff == true and (kind == nil or err.kind == kind)
end

--- The text to show for any error: a failure's own message, or a Lua error's text.
function M.message(err)
  if M.is(err) then
    return err.message
  end
  return tostring(err)
end

return M
