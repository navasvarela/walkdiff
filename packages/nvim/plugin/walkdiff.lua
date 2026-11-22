if vim.g.loaded_walkdiff == 1 then
  return
end
vim.g.loaded_walkdiff = 1

-- vim.system, vim.fs.root and vim.ui.open all arrived in 0.10.
if vim.fn.has("nvim-0.10") == 0 then
  vim.notify("Walkdiff needs Neovim 0.10 or later.", vim.log.levels.WARN)
  return
end

vim.api.nvim_create_user_command("Walkdiff", function(opts)
  require("walkdiff.commands").run(opts.fargs)
end, {
  nargs = "*",
  desc = "Review pull requests with Walkdiff",
  complete = function(lead, line)
    -- Only the subcommand completes; `link` takes a URL.
    if #vim.split(vim.trim(line), "%s+") > (lead == "" and 1 or 2) then
      return {}
    end
    return require("walkdiff.commands").complete(lead)
  end,
})

vim.api.nvim_create_autocmd("BufReadCmd", {
  pattern = "walkdiff://*",
  desc = "Load Walkdiff's reviews list and changed files from the app",
  callback = function(args)
    require("walkdiff.buffers").read(args.buf, args.match)
  end,
})
