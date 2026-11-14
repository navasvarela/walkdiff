# Configuration

## Command options

| Option | Used with | What it does |
| --- | --- | --- |
| `--local` | `review` | Reviews the committed work on the current branch of the repository you're in, before it has a pull request |
| `--base <ref>` | `review --local` | The branch it will merge into (default: the remote's default branch, else `main` or `master`) |
| `--out <dir>` | `review` | Writes the report here instead of the cache folder |
| `--port <number>` | `review`, `app` | Sets the local port. `review` uses 4318, or any free port if that is taken; `app` uses 4317 |
| `--no-serve` | `review` | Writes the report and exits |
| `--no-open` | `app` | Doesn't open your browser. It also stays closed in CI and over SSH |
| `--offline` | `review`, `app` | Skips OSV lookups, Semgrep and osv-scanner |
| `--ai` | `review` | Adds an AI review, which sends the changed code to your AI provider |
| `--ai-provider <p>` | `review` | `anthropic` (default) or `openai-compatible` |
| `--ai-base-url <url>` | `review` | With `openai-compatible`, the provider's address |
| `--ai-model <id>` | `review` | Sets the model (default `claude-opus-5-5`; required with `openai-compatible`) |
| `--ai-max-input-tokens <n>` | `review` | Caps the prompt (default 40,000); larger PRs are summarized |
| `--coverage <file>` | `review` | Reads this LCOV or Cobertura report, instead of looking in CI and the PR for one |
| `--cache-dir <dir>` | `review`, `app` | Sets where repositories and reports are cached |
| `--data-dir <dir>` | `app` | Sets where the review list is stored |
| `--report <dir>` | `comment` | The folder `review` wrote with `--out` |
| `--report-url <url>` | `comment` | Where reviewers can open the report |
| `--log-format <f>` | all | `text` (default), or `json` for [JSON logs](#logs) |

## Environment variables

| Variable | What it does |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN` | Token for GitHub, and GitHub Enterprise once it's trusted |
| `GITLAB_TOKEN` | Token for GitLab, and self-managed GitLab once it's trusted |
| `WALKDIFF_TRUSTED_GITHUB_HOSTS`, `WALKDIFF_TRUSTED_GITLAB_HOSTS` | Hosts besides github.com and gitlab.com that may receive those tokens |
| `ANTHROPIC_API_KEY` | Key for AI review with Anthropic, unless you use an `ant auth login` profile |
| `WALKDIFF_AI_API_KEY` | Key for AI review with an OpenAI-compatible provider; local models usually need none |
| `XDG_CACHE_HOME` | Moves the cache from `~/.cache/walkdiff` |
| `XDG_DATA_HOME` | Moves the app's data from `~/.local/share/walkdiff` |
| `WALKDIFF_LOG_FORMAT` | `text` or `json`, as `--log-format`, which takes precedence |

## Logs

Walkdiff writes what it's doing to stderr, so stdout only carries what a command prints, such as `--help`. By default each message is a plain sentence. With `--log-format json`, or `WALKDIFF_LOG_FORMAT=json` in CI, each is one JSON object per line ([JSON Lines](https://jsonlines.org)):

```json
{"time":"2026-11-13T09:30:00.000Z","level":"info","msg":"Scanning for security problems…","step":"scanningCode"}
{"time":"2026-11-13T09:30:04.112Z","level":"warn","msg":"Walkdiff couldn't install gitleaks: …","scanner":"gitleaks"}
{"time":"2026-11-13T09:30:09.861Z","level":"info","msg":"15 files changed, no security findings. Report written to ./report","files":15,"findings":0,"reportDir":"./report"}
```

| Field | What it holds |
| --- | --- |
| `time` | When it happened, in UTC (ISO 8601) |
| `level` | `info`, `warn` (something didn't work, and Walkdiff carried on) or `error` (the command failed) |
| `msg` | The same sentence the text format prints |
| Others | Facts to filter on, by event: `step` for each analysis step, `reportDir`, `files` and `findings` when a report is written, `url` for a server or download, `scanner` and `version` while installing scanners, `review` in the app, and `version` on a failure |

### Tokens and trusted hosts

Walkdiff only sends tokens to `https://github.com`, `https://gitlab.com` and hosts you've added. For any other host, it reads the link without a token, which works for public repositories. A `GITHUB_TOKEN` goes only to GitHub hosts and a `GITLAB_TOKEN` only to GitLab hosts.

To use GitHub Enterprise or self-managed GitLab, add your host:

```bash
export WALKDIFF_TRUSTED_GITHUB_HOSTS=git.acme.internal
export WALKDIFF_TRUSTED_GITLAB_HOSTS=gitlab.acme.internal,gitlab.acme.dev:8443
```

| Rule | Why |
| --- | --- |
| A bare host means https | A token never goes over plain http unless you write `http://host` in the list |
| Each trusted host of a kind receives the same token | Set the variable to a token meant for the host you're reviewing, not your github.com token |
| The list can't be set in `.walkdiff.json` | That file belongs to the repository the token would be sent to |
| No setup is needed in CI | A job trusts its own server, from `GITHUB_SERVER_URL` or `CI_SERVER_URL` |

In the app, a GitHub CLI login is used for github.com and for hosts in the list.

## Settings in the app

In `walkdiff app`, the Settings page lets you turn optional checks on or off, choose the AI provider and model, test the connection, and see what leaves your machine. Settings are saved in the app's database and only apply to the app. The command line and CI use the options above.

API keys aren't saved by Walkdiff. Set them in the environment before starting the app. A check you turn off appears in reports as a check that didn't run.

## AI providers

| Provider | Example | Key |
| --- | --- | --- |
| Anthropic | The default | `ANTHROPIC_API_KEY` |
| OpenAI | `--ai-provider openai-compatible --ai-base-url https://api.openai.com/v1 --ai-model <name>` | `WALKDIFF_AI_API_KEY` |
| Ollama, on your machine | `--ai-provider openai-compatible --ai-base-url http://localhost:11434/v1 --ai-model llama3.2` | Usually none |

If `ANTHROPIC_BASE_URL` is set, requests and your API key go to that address instead of Anthropic. Settings warns you, and the terminal says where each review is sent. A rule limiting AI to `anthropic` in `.walkdiff.json` then refuses it.

Any service with an OpenAI-style chat completions API should work, as long as its model supports structured output. Addresses must use https unless the model is on your machine. Costs are only estimated for Anthropic models.

## Team rules: `.walkdiff.json`

Put this file at the root of the repository being reviewed. Every setting is optional.

```json
{
  "riskPaths": [{ "pattern": "src/ledger/**", "severity": "high", "reason": "Moves customer funds" }],
  "ignore": ["tests/fixtures/**"],
  "ai": { "allowed": true },
  "scanners": { "semgrep": { "rules": ["p/default"] } },
  "coverage": { "paths": ["reports/**/*.txt"] },
  "dependencies": { "private": ["@acme/*", "acme-*"], "allowedLicenses": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"] },
  "feedback": { "url": "https://forms.example.com/walkdiff" }
}
```

| Setting | What it does |
| --- | --- |
| `riskPaths` | Marks sensitive areas. `severity` is `high`, `medium` or `low`, and `reason` appears in the finding |
| `ignore` | Leaves these paths out of the risk checks. The report says how many files were left out |
| `ai.allowed` | Set to `false` to block AI review for the repository |
| `ai.providers` | Limits where code can go: `"anthropic"`, `"local"` for a model on the reviewer's machine, or a host such as `"api.openai.com"` |
| `scanners.semgrep.rules` | Sets Semgrep registry rule packs (`p/…` or `r/…`). Use an empty list to turn Semgrep off |
| `coverage.paths` | Globs for coverage reports whose names Walkdiff doesn't recognize, in CI artifacts or the PR. |
| `dependencies.private` | Names or globs for your own packages, such as `@acme/*`, `com.acme:*` for Maven or `github.com/acme/**` for Go modules, whose paths need `**`. They're never sent to OSV or package registries, or flagged as missing. |
| `dependencies.allowedLicenses` | SPDX identifiers your team accepts. New dependencies under any other licence, or with none declared, are flagged. Leave it out to skip the check. |
| `feedback.url` | Adds a feedback link to the report and the PR comment |

**A PR can't change its own rules.** Walkdiff reads this file from the PR's merge base, so an edit takes effect only after it's merged. The edit itself is reported as a finding. AI review is blocked if either version of the file forbids it.

## What leaves your machine

| Destination | What is sent | When |
| --- | --- | --- |
| The PR's host | Your token, if the host is trusted, to read the PR and its code | Always |
| OSV | Names and versions of dependencies | Unless `--offline` |
| GitHub and PyPI | Downloads of the pinned scanners, checked against their hashes; nothing of yours is sent | On `pnpm install`, when a version isn't there yet |
| OSV, npm, PyPI, crates.io and deps.dev (for Go modules and Maven artifacts) | Names of new direct dependencies, unless listed in `dependencies.private`; no versions of your code | When a PR adds a dependency, unless `--offline` or turned off in Settings |
| Semgrep registry | A rule download; your code isn't uploaded | During a review, unless `--offline` |
| Your AI provider | The changed code, and the PR's title and description, with known credential formats redacted and credential files left out | Only with `--ai` or the app's AI option. Nothing leaves your machine with a local model |

## Where Walkdiff keeps files

| Path | Contents | Safe to delete? |
| --- | --- | --- |
| `~/.cache/walkdiff` | Cached repositories, reports and AI results | Yes. It's rebuilt on the next run, though existing report links in the app stop working until you refresh those reviews |
| `~/.local/share/walkdiff/walkdiff.db` | The app's review list | Only if you want an empty list |
