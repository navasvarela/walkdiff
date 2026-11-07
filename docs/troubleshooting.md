# Troubleshooting

Find the message you see, or the symptom below. If nothing here helps, [open an issue](https://github.com/navasvarela/walkdiff/issues) with the command you ran and the full error. Leave out tokens and private code.

## Starting Walkdiff

### `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`

You ran `pnpm walkdiff` outside the Walkdiff folder. Change to the folder where you cloned it, then run the command again.

### `Port 4317 is in use`

The app is probably already running, so open `http://127.0.0.1:4317/`. To run another copy, choose a different port:

```bash
walkdiff app --port 4318
```

### `The report UI has not been built`

This happens if you run `packages/cli/src/main.ts` directly. Use `pnpm walkdiff`, which builds the page first, or run:

```bash
pnpm build:ui
```

### Node.js errors on startup

Walkdiff needs Node.js 22.18 or newer. Check your version:

```bash
node --version
```

On Node.js 22 you may see an `ExperimentalWarning` about SQLite. It's harmless.

## Pull requests and access

### `Not a pull request URL`

Use the link to the pull request or merge request itself:

- `https://github.com/owner/repo/pull/123`
- `https://gitlab.com/group/project/-/merge_requests/45`

### `responded 404` or `responded 401`

For a private repository, this usually means the token is missing or can't read it. GitHub and GitLab both answer 404 for a private repository you can't see, so the link may be fine.

1. Check that the link opens in your browser.
2. Set a token, as shown in [Getting started](getting-started.md#private-repositories).
3. For GitLab, check that the token has the `read_api` and `read_repository` scopes.
4. For a GitHub organization that uses SSO, authorize the token for that organization.

In the app, a token set in the terminal only applies if it was set before `walkdiff app` started. Restart the app after changing it.

### `Walkdiff sent no token, because … is not a trusted host`

Walkdiff doesn't send tokens to a host until you add it, so a private repository on GitHub Enterprise or self-managed GitLab fails until then. If you trust the host, add it and run the review again. See [Tokens and trusted hosts](configuration.md#tokens-and-trusted-hosts).

### Upgrading from Lens

- **Config:** `.lens.json` keeps working, and `.walkdiff.json` takes priority if both exist.
- **Trusted hosts:** rename the variables to `WALKDIFF_TRUSTED_GITHUB_HOSTS` and `WALKDIFF_TRUSTED_GITLAB_HOSTS`. Until you do, Walkdiff sends no token to those hosts.
- **Saved reviews:** the app starts with an empty list. The old data is still in `~/.local/share/lens`, and you can delete it and `~/.cache/lens`.

### `Not a host name in a trusted hosts variable`

An entry in `WALKDIFF_TRUSTED_GITHUB_HOSTS` or `WALKDIFF_TRUSTED_GITLAB_HOSTS` isn't valid. Use comma-separated hosts, such as `git.acme.internal,git.acme.dev:8443`.

### `refused a redirect to another host`, or git fails with a redirect error

Walkdiff doesn't follow a redirect to another host while it holds a token, so the token can't go with it. Use the link's final address. For a renamed or moved repository, use its current link.

### `responded 403` from GitHub

You have probably hit the API rate limit, which is low without a token. Set `GITHUB_TOKEN` or `GH_TOKEN`. If you already have, check that the token can read the repository.

### `did not provide …; the branch may have been force-pushed`

The commits Walkdiff asked for are no longer on the host. Run the review again so it picks up the latest commits. If it's a review in the app, refresh it.

### `git fetch failed: fatal: transport 'ssh' not allowed`

Your git config sends https to ssh, with a rule such as `url."ssh://git@gitlab.com/".insteadOf = https://gitlab.com`, and the Walkdiff you're running is older than 0.7.1. Walkdiff only fetches over https, and since 0.7.1 it keeps its own fetch on https whatever your rules say, so you can keep them.

Check which Walkdiff runs with `walkdiff --version`. Every error also ends with the version. If it's older than 0.7.1:

- Stop any running `walkdiff app`: it keeps the version it started with.
- Run `which -a walkdiff`. If it lists more than one, the first one is what runs; update or remove the others.
- With `npx`, name the version, such as `npx walkdiff@latest app`, since npx reuses one it already has.

### `GitLab has not computed the diff … yet`

Wait a moment and try again. This is common just after a merge request is opened.

### `.walkdiff.json is not valid JSON` or `.walkdiff.json is invalid`

The repository's own `.walkdiff.json` has a mistake, and the review stops until it's fixed. Walkdiff reads the file from the PR's merge base, so fixing it in the PR doesn't help. Fix it on the target branch, then run the review again. The settings are listed in [Configuration](configuration.md#team-rules-walkdiffjson).

## The report

### The page is blank or stuck on "Loading review…"

1. Reload the page.
2. Check that the terminal running Walkdiff is still open, because the address stops working when Walkdiff stops.
3. Generate the report again with `pnpm walkdiff`, which also rebuilds the page.
4. If it's still blank, open the browser's developer console and include any error in your issue.

### The Changes tab shows a line diff instead of functions

Walkdiff only understands Rust, TypeScript, JavaScript and Python. Other languages get a line diff, and so do files over 1 MB and files that aren't text.

### A file is collapsed or marked as skippable

Walkdiff groups lockfiles, vendored code and generated files. A file counts as generated if its path suggests it, or if it has a `@generated` or `DO NOT EDIT` header. You can still expand it.

### A function shows as removed and added

Walkdiff recognises a function that was moved and edited if it kept its name and most of its code. It's shown where it arrived, as "Moved from … and edited", with the old and new code side by side. Moves without edits are folded away.

It still shows as removed and added when:

- it was renamed as well as moved and edited
- most of it was rewritten
- it's very short: a one-line function looks like too many others to tell it was moved

### Impact shows a caller that isn't really a caller

Walkdiff finds references by name and syntax, not by resolving types, so another function with the same name can match. Check the confidence label:

- **Exact:** qualified with the type, such as `Size::new`.
- **Likely:** a direct use of the name.
- **Possible:** `x.method()` where the type of `x` is unknown. These are the most likely to be wrong.

### Impact says a name is too common to trace

Names found in more than 200 files, such as `new` or `get`, aren't traced. Very large PRs may also trace only some of their changes, and the report says so.

### It says "No security findings", but I expected some

Check "Not checked" on the Risks tab first. Also note that:

- Scanners only report problems on lines the PR added, so older problems don't appear.
- Paths under `ignore` in `.walkdiff.json` aren't checked.
- Lockfiles and vendored code aren't checked by the secret and code rules.

A low level never means the change is safe.

## Posting reviews

### `This PR has new commits since this report was made`

Nothing was posted, so a review can't reach code you haven't read. Refresh the review in the app. Your comments and ticks are kept, and anything that changed comes first.

### `Resource not accessible`, or a 403 or 404 when posting

Your token can read the PR but not write to it. It needs `pull-requests: write` on GitHub, or the `api` scope on GitLab.

### `Can not approve your own pull request`

GitHub doesn't allow this. Post a comment instead.

### A comment appears in the review's text, not on a line

Hosts only accept comments on lines in the diff. A comment on something with no added lines, such as a removed function, goes in the review's text with its name.

### There's no way to post from my report

Posting only works in the app, opened with `walkdiff app`. A report opened from a file or CI can't post, so copy your comments from the finish screen.

## Test evidence

### `isn't a coverage format Walkdiff can read`

Walkdiff reads LCOV and Cobertura XML. Most test tools can write one of them, such as `coverage xml` for Python, or the `lcov` reporter for Vitest and Jest.

### A change says the report has no line data

The report doesn't cover that file, or its path matches more than one file in the report. Walkdiff won't guess, because it could show the wrong file's coverage. Generate the report from the repository root so paths are complete.

### The coverage looks wrong

The report probably came from a different commit than the PR's latest. Generate it from that commit, as line numbers need to match.

## Security scanners

### A scanner is listed under "Not checked" as not installed

Run this, read what it says about the scanner, then start Walkdiff again:

```bash
walkdiff setup
```

From a clone of the repository, that's `pnpm walkdiff setup`.

Usually Semgrep is the one missing, because it needs Python 3.10 or later with the `venv` module. On Debian and Ubuntu, that's the `python3-venv` package. A network that blocks GitHub or PyPI also stops the install.

On Windows, or if you'd rather use your own copies, install them yourself. Walkdiff uses them when it has none of its own, but it has to see them on your `PATH`. Check from the terminal that starts Walkdiff:

```bash
which semgrep gitleaks osv-scanner
```

When you start `walkdiff app`, its log lists the scanners it found.

### A scanner is listed as failed

The reason shown is the first line of the scanner's error. The usual causes are:

- **Semgrep can't download rules:** check your network or proxy. You can use `--offline` to skip it.
- **A rule pack doesn't exist:** check `scanners.semgrep.rules` in `.walkdiff.json`.
- **A very large PR:** each scanner stops after 5 minutes.

### `# nosemgrep` or `gitleaks:allow` doesn't hide a finding

This is on purpose, so that a PR can't hide its own findings. Scanner config files in a PR, such as `.gitleaks.toml`, aren't used either.

### A false alarm on one path

Add the path to `ignore` in `.walkdiff.json` on the target branch. This removes it from all risk checks, not only the one that raised the alarm.

### The same line has two findings

A built-in rule and Semgrep can both flag one line, as with `shell=True`. Walkdiff keeps both, in case they're about different problems. Ruff's security rules are different: they overlap so much with the built-in rules and Semgrep's that where either flags a line, Ruff's finding is left out. Repeated secrets on a line are merged into one.

## AI review

### `Anthropic rejected the credentials`

Set `ANTHROPIC_API_KEY`, or run `ant auth login`.

### `.walkdiff.json forbids sending this repository's code to a model`

Either version of `.walkdiff.json` (the merge base or the PR) has `"ai": { "allowed": false }`. Someone with access to the target branch has to change it.

### `could not reach` or `answered` from another provider

Use "Save and test connection" on the Settings page, which sends no code. Check that the address includes the API path, such as `/v1`, and that a local server is running. Some servers don't offer the model list that test uses, so a real review may still work.

### `the response did not match the expected review format`

The model didn't return structured output. Try a model that supports it, or a different provider.

### `could not reach`, naming an address you don't recognize

`ANTHROPIC_BASE_URL` is probably set in the terminal that started Walkdiff, sending requests to that address instead of Anthropic. If nothing is meant to be there, run `unset ANTHROPIC_BASE_URL` and start Walkdiff again.

### A package of yours is flagged as not on the registry

Walkdiff checks new dependencies against public registries. List your own packages under `dependencies.private` in `.walkdiff.json`, such as `"@acme/*"`, and they're skipped and never sent out. Until then, these names do go to the registries. If the name isn't yours, it may be made up, and anyone could register it.

### `only allows AI review with`

The repository's `.walkdiff.json` limits where its code can go. Choose one of the providers it lists on the Settings page.

### `rate limited by the Anthropic API`

Wait a little and run it again.

### The AI review says some units were sent by name only

The PR went over the prompt budget. Raise it with `--ai-max-input-tokens`, which also raises the cost. The report shows the tokens used and the estimated cost.

### `the model declined to review this change` or `the response exceeded … and was cut off`

The rest of the report is unaffected. Try again, or review this PR without AI. For a response that was cut off, a smaller PR usually helps.

## The app

### A review says `The app stopped during this analysis`

The app was closed while the review was running. Refresh that review to run it again.

### A review stays on "Queued"

Analyses run one at a time, so it's waiting for the one before it. A large repository's first analysis can take several minutes.

### The app's API refuses a request

The app only answers on `127.0.0.1` and `localhost`, and its API needs a key created each time it starts. After restarting the app, reload the page. Opening it through another host name or a proxy won't work.

## CI

### No comment appears on the pull request

- **PR from a fork:** GitHub gives these a read-only token, so no comment is posted. The summary is on the workflow run's page instead.
- **Missing permission:** the GitHub workflow needs `pull-requests: write`.
- **GitLab:** `GITLAB_TOKEN` must be a masked CI/CD variable with the `api` scope, and the job needs merge request pipelines.

### `This workflow run is not for a pull request`

Trigger the workflow with `on: pull_request`.

### `This pipeline is not for a merge request`

Run the job on `merge_request_event`.

### The report link in the comment doesn't open

On GitHub, the link needs someone signed in with access to the repository. Artifacts also expire, 14 days after the run by default. Push a new commit or re-run the job to create a new one.

### Scanners are listed as not installed in CI

CI runners don't have them by default. Install them in the job before Walkdiff runs.

## Starting fresh

If a cached repository seems wrong, delete the cache. It's rebuilt on the next run:

```bash
rm -rf ~/.cache/walkdiff
```

Existing reports in the app stop opening until you refresh them. To also empty the app's review list, stop the app and delete `~/.local/share/walkdiff/walkdiff.db`.
