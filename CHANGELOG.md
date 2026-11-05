# Changelog

## Unreleased

- **No duplicate-code warnings on migrations:** migration files, such as db-migrate's, repeat the same template by design and must not share code, so duplicate detection now leaves them out. Rails' `db/migrate/` now also counts as a database migration for the sensitive-path check, as it already did for breaking changes.
## 0.7.1

- **Works with git configs that route https to ssh:** a `url.*.insteadOf` rule that sends `https://gitlab.com/` or `https://github.com/` to ssh, common for cargo or go with private repositories, made reviews fail with "transport 'ssh' not allowed". Walkdiff's own fetch now stays on https with its token, and the rule still applies to everything else.

## 0.7.0

- **Progress while a review is analyzed:** the app shows a bar with the step under way, such as "Step 6 of 9: Scanning for security problems", instead of only "Analyzing…". The command line prints each step as it starts, so CI logs show where a slow run is.
- **Conversation threads show their code:** each thread shows the lines around the one it's on, with that line marked, and "Show line 12 in Changes" opens the file scrolled to it. Threads collapse to one line (where, who, and how it starts) so a long discussion is easy to scan; beside the code on the review path they start open.
- **Comment counts:** files with open comments on the PR show 💬 and how many in the file list, and so does each stop on the review path. The count drops as threads are resolved.
- **Comments on removed lines are placed correctly:** GitHub's left-side comments counted their line in the new version of the file, and GitLab's had no line at all. Both now keep the side they're on.

## 0.6.1

- **Posting a review to GitLab no longer reports a false failure:** the app said "Something went wrong" after the comments were posted, and posting again duplicated them. GitLab answers with an empty reply, which Walkdiff now accepts.
- **Untested code stays on the review path:** a change where coverage shows half or more of its lines didn't run, or whose file no test loaded, is now enough on its own to be a stop. Before, a new function no test called, with no callers yet, could be left off the path. Coverage tools mark a function's first line as run whenever its file loads, so such a function shows one line run, not none.
- **Coverage from GitLab test jobs:** the app now finds coverage in any GitLab job that declares `artifacts:reports:coverage_report`, such as a job named `test`, not only in jobs with "cov" in their name.
- **New files tests never loaded:** when a coverage report covers other files in the same language but leaves out a changed file, the review path says no test may have loaded it, instead of saying nothing. Tools such as c8 and Jest only list files the tests load.
- **The finish screen's heading** no longer overlaps the line below it.
- **GitLab setup advice:** the pilot guide and template explain that gitlab.com Free has no project access tokens, that the token variable must be unprotected, and how to hand coverage to the Walkdiff job.

## 0.6.0

- **Comment on exact lines:** click a line number in the code to comment on that line, or shift-click to pick several. It works on changed and unchanged lines, before or after the change. Comments post to those lines on GitHub, and on GitLab to the last line of a range, naming the rest. Lines outside the diff can't take a comment, as hosts don't accept them there.
- **Moved and edited code is recognised:** a function moved to another file or class and edited on the way now shows as "Moved from … and edited", with its old and new code side by side, instead of as removed in one place and added in another. Its callers are traced, and it counts as a change to review.

## 0.5.0

- **Install from npm:** `npx walkdiff app`, or `npm install --global walkdiff`, instead of cloning the repository. Releases are published from GitHub Actions with provenance.
- **The Action and GitLab template use the npm package,** pinned to their release, so they no longer clone and build Walkdiff on every run. The Action takes a `package` input to choose another version.
- **`walkdiff setup`,** and scanners install on first use: they now live in your cache folder, `~/.cache/walkdiff/scanners`, rather than inside the code, and don't depend on npm install scripts. `--offline` skips installing them.

## 0.4.0

- **Fairer "Large change":** requirements files locked with hashes now count as lockfiles, so generated lines no longer inflate the size.
- **App top bar:** the review list and Settings now have the logo and the same bar as reports.
- **Wording:** the PR comment now says "1 place … uses" rather than "use".
- **Licence check:** list the licences your team accepts under `dependencies.allowedLicenses` in `.walkdiff.json`, and new dependencies under any other licence, or with none declared, are flagged. It's off until you set a list.
- **Ruff now installs with Walkdiff,** so Python PRs stop listing it as not run.
- **zizmor checks GitHub Actions workflows** a PR changes, for problems such as injection and over-broad permissions. It only reads the workflow, and a PR can't silence it. There's no equivalent for GitLab CI yet.
- **Dependency trust check:** new direct dependencies are flagged if they're known malicious, aren't on npm, PyPI or crates.io, were first published in the last 30 days, or have a name one character from a popular package. List your own packages under `dependencies.private` in `.walkdiff.json` to keep them private.
- **Malicious packages rank High:** known malicious versions found in lockfiles no longer show as Medium.
- **`requirements/*.in` files are now read** as dependency lists, along with `requirements*.in`.
- **Shows where AI review really goes:** with `ANTHROPIC_BASE_URL` set, Settings, the review list and errors now name that address instead of saying Anthropic, and a repository rule limiting AI to `anthropic` no longer passes. Plain http is refused unless the address is on this machine.

## 0.3.0

- **Redesigned brief:** a top bar on every page shows the logo, where you are and your progress, and the brief now has a clear starting card and a sidebar with the numbers and each check's result.
- **Clearer PR comment:** it now has the Walkdiff logo, tables, code font for names, and findings that link straight into the PR's diff.
- **No more "security level":** "Low" sounded like a verdict, but Walkdiff runs pattern and secret scans on added lines, not a security audit. Comments and reports now say what was found, such as "No security findings", and which checks looked.
- **Easier to read Impact tab:** each change now starts collapsed under a headline saying what depends on it, most exposed first, with a warning colour when removed or renamed code is still in use.
- **Shorter AI review:** it now leads with where the code differs from the description, then questions to answer, one line each, with explanations on demand. Points about a change also appear beside its code on the review path.
- **See why changes are highlighted:** the brief explains how the path is chosen, what it leaves out and what it can miss. Flagged changes now always stay on the path, whatever its limit, and findings it can't reach are called out.
- **Results per check:** the Risks tab has a table of every check with its issues, or why it didn't run, and the brief sums it up.
- **Link back to all reviews** on the brief and the review path, in the app.
- **AI choice respected when adding a PR again:** in the app, adding a PR already on the list now uses the **Include AI review** box as it is, instead of ignoring it.
- **The app opens your browser:** `pnpm walkdiff app` now opens the review list. Use `--no-open` to turn this off.
- **Coverage for each PR, with no setup:** Walkdiff now looks for a report in CI artifacts of the PR's latest commit and in files the PR adds to a folder, in the app too. Or choose **Attach coverage** on a review: the report updates at once, with no restart.
- **Clearer all-clear:** the brief and the PR comment now say what was found absent and name the checks used, instead of saying "the checks that ran".
- **Semgrep, gitleaks and osv-scanner now install with Walkdiff,** so reports stop saying they didn't run, in CI too. `pnpm install` fetches pinned versions and checks them against hashes in this repository, on macOS and Linux. Semgrep needs Python 3.10 or later.
- **oxlint and jscpd now install with Walkdiff,** so they work with no extra setup, including in CI, at versions pinned in the lockfile. Earlier global installs are no longer used.
- **Post your review:** in the app, post comments and Comment, Approve or Request changes from the finish screen, to GitHub or GitLab. Nothing is posted until you press the button, and Walkdiff refuses if the PR has new commits since the report was made.
- **Conversation:** the app shows existing threads in a new tab and beside each change, where you can reply and resolve them, plus who has reviewed so far.
- **Fewer false warnings:** reports no longer list "Change history" under checks that didn't run on every PR. It was never built, so it wasn't a gap you could do anything about. It's still planned.
- **Syntax highlighting:** code in the report is now coloured for Rust, TypeScript, JavaScript and Python, in light and dark mode, alongside the added and removed colours and edited-word marks. Other files stay plain, and so do very long lines and very large files, to keep the page fast.
- **Breaking changes:** Walkdiff flags public APIs, database migrations, environment variables and config keys that could break other code or a deployment. Each one is a stop on the review path that says what could break and which callers are affected. These findings never change the security level. See [Breaking changes](README.md#breaking-changes). The review model schema is now version 11.
- **Settings page:** the app now has a page to turn optional checks on or off, choose the AI provider and model, test the connection, and see what leaves your machine.
- **More AI providers:** besides Anthropic, Walkdiff can use any OpenAI-compatible service or a local model such as Ollama, with `--ai-provider openai-compatible --ai-base-url <address> --ai-model <name>`. Keys come from `WALKDIFF_AI_API_KEY`, and only https addresses are accepted unless the model is on your machine.
- **Team limits on AI:** `"ai": { "providers": ["local"] }` in `.walkdiff.json` limits where a repository's code can be sent.
- **Changes since your last review:** progress and comments now belong to the PR, not the commit. After a new push, ticks stay on what didn't change, and anything you reviewed that did change comes first, showing the difference from the version you saw. Progress saved by earlier versions isn't carried over.
- **Test evidence:** `--coverage` reads an LCOV or Cobertura report and shows whether each change's lines ran in tests. Changes whose lines didn't run rank higher. Also available as the Action's `coverage-file` input and the GitLab template's `WALKDIFF_COVERAGE` variable. The review model schema is now version 10.

## 0.2.0

- **Renamed to Walkdiff.** The command is now `pnpm walkdiff`, the config file is `.walkdiff.json`, and the trusted hosts variables are `WALKDIFF_TRUSTED_GITHUB_HOSTS` and `WALKDIFF_TRUSTED_GITLAB_HOSTS`. An existing `.lens.json` keeps working, but the old variables don't, so set the new ones or tokens won't be sent to those hosts. Saved reviews aren't moved, so the app starts with an empty list.
- **Code quality:** Walkdiff flags complexity, long functions and lint problems in the code a PR adds, using built-in measures and optional Ruff, oxlint and jscpd. Findings appear as reasons on the review path and never change the security level.

## 0.1.0

The first release, published under the name Lens. Walkdiff is early software, so expect changes, and it hasn't had an independent security audit.

### The review

- **Guided review:** the report opens on a brief with what to check and where to start, then takes you through the changes that matter most, explaining why each one is there.
- **Progress and comments:** mark changes as reviewed and leave comments, on the path or in All changes. Both are saved in your browser, by commit. Comments can be copied for the PR, but aren't posted to it yet.
- **Whole functions:** each changed function or type appears whole, before and after, for Rust, TypeScript, JavaScript and Python. Other languages get a line diff.
- **Impact:** where the rest of the code uses what changed, and which callers the PR didn't touch.
- **Risks:** a security level, built-in rules for secrets, risky APIs and sensitive areas, and known vulnerabilities through OSV.
- **Security scanners:** optional Semgrep, gitleaks and osv-scanner.
- **AI review:** optional reading order, description check and questions. Nothing is sent without `--ai`.

### Using it

- `walkdiff review` for a single report, and `walkdiff app` to keep track of several reviews.
- A GitHub Action and a GitLab CI template that add a report and a summary comment to each PR.
- Team rules in `.walkdiff.json`, read from the merge base so a PR can't change its own rules.

### Security

- Tokens go only to github.com, gitlab.com and hosts you trust.
- Pull request code is never built or run.
- See [SECURITY.md](SECURITY.md) for the guarantees and their limits.

### Known limits

- Not yet tried against a real GitLab merge request, GitHub Enterprise, self-managed GitLab or a live AI review.
- The review path's ranking uses simple rules, and hasn't been tested with reviewers yet. It can rank an important change too low, so use All changes when in doubt.
- Progress doesn't carry over to a new push.
