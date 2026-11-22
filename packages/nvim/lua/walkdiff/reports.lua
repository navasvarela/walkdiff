-- Reports read from the app, kept until their review changes. The reviews list, the diff buffers'
-- findings and the quickfix list all ask for the same reports, and each can be a few megabytes.
local M = {}

local cache = {}

--- The report for this version of the review (`{ id, updatedAt }`), read again when the review
--- has changed since. Without `updatedAt`, the last report read for the review.
function M.get(app, review)
  local cached = cache[review.id]
  if cached ~= nil and (review.updatedAt == nil or cached.updated_at == review.updatedAt) then
    return cached.report
  end
  local report = app:report(review.id)
  cache[review.id] = { updated_at = review.updatedAt, report = report }
  return report
end

return M
