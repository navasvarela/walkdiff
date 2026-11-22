-- The names of the plugin's buffers. A changed file's side is `walkdiff://<review>/<base|head>/<path>`,
-- loaded from the app by a BufReadCmd, so it can be opened, split and listed like any file.
local M = {}

M.REVIEWS = "walkdiff://reviews"
local SIDES = { base = true, head = true }

function M.changed_file(review_id, side, path)
  return string.format("walkdiff://%d/%s/%s", review_id, side, path)
end

--- The review, side and path a buffer name stands for; nil for any other name.
function M.parse_changed_file(name)
  local id, side, path = name:match("^walkdiff://(%d+)/(%a+)/(.+)$")
  if id == nil or not SIDES[side] then
    return nil
  end
  return { review_id = tonumber(id), side = side, path = path }
end

return M
