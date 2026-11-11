<img src="docs/assets/walkdiff-logo.svg" alt="" width="48" height="48">

# walkdiff

A review companion for GitHub pull requests and GitLab merge requests. `walkdiff review <url>` fetches the
change, analyzes it, and serves a local report.

Status: early release, [v0.9.0](CHANGELOG.md). To run it on your team's PRs, see the [pilot guide](docs/pilot.md).

**Documentation:** [getting started](docs/getting-started.md), [configuration](docs/configuration.md), [troubleshooting](docs/troubleshooting.md), [security policy](SECURITY.md).

## What the report shows

The report opens on a brief: what to check, how many changes need attention, and where to start. A review path then takes you through the changes that matter most, one at a time, with why each one is there, its code, callers and tests. You can mark changes as reviewed and leave comments, and everything else stays one link away under **All changes**. In the app, you can then post your review to the PR and join the discussion.

All changes has five tabs, including **Conversation** in the app: **Changes** (files, the map of each file and the changed units), **Impact** (where other code uses what changed), **Risks** (each check's result and every finding) and **AI review**. Each tab shows a count, and its name in the URL lets you link to it, as in `#risks`.

- **Changed units, not hunks.** For Rust, TypeScript/JavaScript, Python, Go, Java, C and C++, each changed function,
  method, type, class or macro appears once, whole, before and after, with edited words marked. A class shows only the
  code it owns; its methods are separate cards. In JavaScript and TypeScript tests, each `describe`,
  `it`/`test` and hook such as `beforeEach` is a unit too, named by its title, such as `parser › reads includes`.
  A class or suite that is new as a whole is one card with everything in it.
- **A map of each file.** When a file has several changed units, an outline shows which ones changed among all its definitions, how big they are, and which changed function calls which. Cards are in reading order: types first, then helpers before the code that calls them, with collapsed changes last.
- **Change facts.** Each modified function lists what changed without reading it, worked out from the syntax: parameters, return type, calls added or removed, and more or fewer error paths and branches.
- **Noise collapsed.** Formatting-only and comment-only edits, renames with unchanged bodies, and units moved
  unchanged between files or containers are folded away. Lockfiles, vendored and generated files (by path
  or a `@generated` / `DO NOT EDIT` header) are grouped as skippable.
- **Blast radius.** For every function, method or type the PR changes, removes or renames, the report
  lists where the rest of the code still uses it, linked to the host at the head commit, and flags the
  callers this PR did not touch. Removed and renamed units show any references left behind.
- **Risks and security findings.** Built-in rules flag likely secrets (redacted in the report), risky APIs
  such as `eval`, `shell=True`, raw HTML, `unsafe`, Go's `InsecureSkipVerify`, Java deserialization or C's
  `strcpy` (only in code, not comments or strings), sensitive
  areas such as auth, payments, migrations and CI, new dependencies, and known vulnerabilities in
  dependency versions new to `package-lock.json`, `Cargo.lock`, `poetry.lock`, `uv.lock` or pinned
  requirements (via [OSV](https://osv.dev); `--offline` skips it). Review signals add large PRs, missing
  test changes and removed or renamed units that untouched code still uses. The report says what was
  found rather than grading the change, and lists the checks that ran and those that did not. These are
  pattern and secret scans of added lines, not a security audit. [Security scanners](#security-scanners) add more when installed.
- **Breaking changes.** Flags changes that could break other code or a deployment, and puts them on the
  review path saying what could break and who is affected. [More below](#breaking-changes).
- **AI review (opt-in, `--ai`).** A suggested reading order that groups the changed units into chapters,
  a check of the PR description against the code (matches, contradicts, not in the description, not found),
  and specific questions to answer before approving. Every statement must cite lines of the change; the
  engine checks each citation against what the model was shown and discards the rest. Results are cached
  per prompt, and the report shows tokens used and the estimated cost.
- **Line diff fallback** for other languages, skipped files, and on demand.

References are found by name and syntax, not type resolution: each carries a confidence (exact when
qualified with the unit's type, likely for a direct use, possible for `x.method()` on an unknown type),
and parameters or locals that shadow the name are ignored. Names in more than 200 files (`new`, `get`)
are reported as too common to trace.

Known limits: tests are recognised by the usual names (`describe`, `it`, `test` and their hooks), so a
test helper with another name shows under "imports & top level"; a unit renamed as well as moved and
edited, or mostly rewritten, shows as removed plus added (see
[troubleshooting](docs/troubleshooting.md#a-function-shows-as-removed-and-added)); code is highlighted
only in Rust, TypeScript/JavaScript, Python, Go, Java, C and C++; and `.h` headers are read as C++, which
reads C too unless the code uses a C++ keyword such as `new` as a name.

## Usage

Requires Node.js 22.18 or newer and git.

```sh
npx walkdiff review https://github.com/owner/repo/pull/123
npx walkdiff review https://gitlab.com/group/project/-/merge_requests/45 --no-serve --out ./report
```

Or install it once with `npm install --global walkdiff`, then run `walkdiff`. To work on Walkdiff itself,
clone this repository, run `pnpm install`, and use `pnpm walkdiff` in place of `walkdiff`.

Set `GITHUB_TOKEN` (or `GH_TOKEN`) and `GITLAB_TOKEN` for private repositories and higher API rate limits.
GitHub Enterprise and self-managed GitLab work by URL; tokens go to them only once they're [trusted](docs/configuration.md#tokens-and-trusted-hosts). Run `pnpm walkdiff --help` for all options.

## Keep track of several reviews

```sh
npx walkdiff app
```

This runs a local page at `http://127.0.0.1:4317/`. Paste a pull request or merge request link to add it; analyses run one at a time, and the list shows each review's status and counts, and flags medium or high severity security findings. Refresh re-runs a review after new commits. The list is kept in SQLite under `~/.local/share/walkdiff`, so it survives restarts. If `GITHUB_TOKEN` is not set, the app asks the GitHub CLI for its login on that PR's host.

The server listens only on your machine, refuses requests for any other host name, and its API needs a key that is created each run.

## Private repositories

Private repositories and merge requests work once a token is in the environment. It is used for both the host's API and fetching the code, and it stays out of the command line and the cached repository's config.

**GitLab**: create a personal or project access token with the `read_api` and `read_repository` scopes (`api` if you will also post comments with `walkdiff comment`):

```sh
GITLAB_TOKEN=<token> walkdiff review https://gitlab.com/group/project/-/merge_requests/123
```

**GitHub**: use a token that can read the repository. With the GitHub CLI:

```sh
GH_TOKEN=$(gh auth token) walkdiff review https://github.com/owner/repo/pull/123
```

`GITHUB_TOKEN` works too. Self-managed GitLab and GitHub Enterprise are recognized from the URL and use the same variables, once listed in `WALKDIFF_TRUSTED_GITLAB_HOSTS` or `WALKDIFF_TRUSTED_GITHUB_HOSTS`. Without a token, a private repository usually answers 404, and walkdiff says which variable to set.

Tokens and code stay on your machine, apart from the host itself, package names and versions sent to [OSV](https://osv.dev) (`--offline` skips that), and the code sent to the model if you pass `--ai`.

## In CI

The GitHub Action (`navasvarela/walkdiff@v0.9.0`) and the GitLab template (`ci/gitlab-ci.yml`) generate the report for each PR, keep it as a job artifact, and post one summary comment that is updated on each push. The [pilot guide](docs/pilot.md) has the setup. Locally, `walkdiff review` also works without a URL inside a CI job, and `walkdiff comment --report <dir> --report-url <url>` posts the summary.

## AI review

`--ai` sends the changed code, the PR title and description to Claude (`claude-opus-5-5` by default;
`--ai-model` to change it) through the official Anthropic SDK. Credentials come from `ANTHROPIC_API_KEY`
or an `ant auth login` profile. `--ai-max-input-tokens` (default 40,000, about $0.16 of input) caps the
prompt; past it, units are sent by name only and the report says how many. Without `--ai`, nothing is
sent. A repository can forbid AI review entirely with `"ai": { "allowed": false }` in `.walkdiff.json`.

## Security scanners

Walkdiff installs pinned versions of [Semgrep](https://semgrep.dev),
[gitleaks](https://github.com/gitleaks/gitleaks), [osv-scanner](https://github.com/google/osv-scanner),
[Ruff](https://docs.astral.sh/ruff/), [zizmor](https://docs.zizmor.sh/) and
[poutine](https://github.com/boostsecurityio/poutine) on its first run, or when you run
`walkdiff setup`, checked against hashes in this repository, on macOS and Linux. They live in
`~/.cache/walkdiff/scanners`, just for Walkdiff. Semgrep needs Python 3.10 or later. If one can't be
installed, Walkdiff still runs, and the Risks tab lists it under "Not checked". Copies on your `PATH`
are used only when Walkdiff has none of its own. `--offline` skips installing them.

| Scanner | Finds | Network |
| --- | --- | --- |
| Semgrep | Risky code patterns, using the `p/default` rules | Downloads rules; your code is not uploaded |
| gitleaks | Secrets | None |
| Ruff security rules | Insecure Python, using Bandit's rules: `shell=True`, `pickle`, `yaml.load`, `verify=False`, SQL built from strings and more. Test files are skipped | None |
| osv-scanner | Known vulnerabilities in `pnpm-lock.yaml`, `yarn.lock` and `bun.lock` | Sends package names and versions to OSV |
| zizmor | Security problems in GitHub Actions workflows | None |
| poutine | Security problems in GitLab CI, Azure Pipelines and Tekton: `curl \| sh`, debug tracing that prints secrets into job logs, injection through CI component inputs | None |

Only findings on lines the PR added are reported, and `--offline` skips Semgrep and osv-scanner.
Ruff's security rules still run offline. Where the built-in rules or Semgrep already flag a line,
Ruff's finding is left out.
Scanners read a temporary copy of the changed files, without your tokens in their environment. A PR
cannot silence them: `# nosemgrep` and `gitleaks:allow` comments are ignored, and scanner config files
in the PR (`.gitleaks.toml`, `.semgrepignore`, `.poutine.yml` and others) are not used. Those files are not scanned either.

For GitLab CI, Walkdiff's built-in rules add what poutine doesn't check: merge request titles, branch
names or commit messages run through `eval` or `sh -c`, remote includes without `integrity`, project
includes without `ref`, components on `~latest` or a branch, and images with no version. Both follow
the local includes of `.gitlab-ci.yml`, so an MR that only edits an included file is still checked.

Choose Semgrep's rules in `.walkdiff.json`; an empty list turns Semgrep off:

```json
{ "scanners": { "semgrep": { "rules": ["p/default", "p/owasp-top-ten"] } } }
```

CI runners need the scanners installed in the job before running Walkdiff.

## Breaking changes

Walkdiff flags changes that could break other code or a deployment, under the "Breaking change" category
in the Risks tab. Each one is a stop on the review path that says what could break and who is affected,
ranked above ordinary medium findings and below high ones. These findings never count as security findings,
because they expose nothing to an attacker.

The rules read syntax, not types, so they say "may break" unless a required parameter changed and calls
to the function are left behind. They would rather stay quiet than raise a false alarm.

**Public APIs**, for Rust, TypeScript, JavaScript, Python and Go: a removed or renamed function or type, an
item that stops being public, removed or newly required parameters, and changed parameter or return types.
Other changes aren't flagged, such as a renamed parameter in Rust, TypeScript or Go, a new optional parameter,
or a wider parameter type. Being marked public isn't enough, since apps mark their own modules that way too.
A change also needs someone it can affect:

| Language | Public | Other projects can reach it when |
| --- | --- | --- |
| Rust | A bare `pub` (not `pub(crate)`) | The crate has `src/lib.rs`, isn't `publish = false`, and every module up to the root is `pub mod` or re-exports it |
| TypeScript, JavaScript | `export` | The package isn't `private` and its entry point exports it, directly or through `export ... from` |
| Python | No leading underscore | The project has a build backend, no part of the module path starts with an underscore, and `__all__`, if any, lists it |
| Go | A capitalised name, and for a method, a capitalised type | A `go.mod` is above it, the package isn't `main`, and no folder on its path is `internal` |

Java isn't covered yet, since nothing in a Java project's files reliably tells a published library from an
application. Neither are C and C++, whose API is whatever the installed headers declare.

Otherwise it's flagged only if calls this PR didn't touch remain in the repository. Python and TypeScript
functions under a framework's decorator are skipped, as the decorator can change how they're called. So is a
name that's still available after its definition went, through an alias, a `__getattr__` shim or a move to
another file. A removal that untouched code still uses shows up as a broken reference instead.

**Database migrations:** dropped or renamed tables and columns and changed column types, in raw SQL (including
Prisma, Goose, dbmate and Flyway files), Alembic, Django, Rails, Knex, Sequelize and TypeORM. Only the added lines
that run on the way up count, so rollbacks aren't flagged. Neither are temporary tables, or names the
same PR creates, such as a table rebuilt or a column replaced under its old name. It's high only when code still
mentions an unusual name. Django's `AlterField` isn't checked, since it mostly changes options.

**Config and environment:**

- A variable renamed in a `.env.example`-style file, or code that now reads a new variable instead of an old
  one. Deployments set the old name, so these are always flagged.
- A variable removed from an env file, CI config or Compose file while code still needs it. A read with a fallback
  doesn't count, and in `apps/`, `packages/`, `services/` or `libs/` only the same project counts.
- A key removed from a config file (`config/*.yml`, `settings.toml`, `appsettings.json`, `*.example.json` and
  similar) while code still reads it. Ordinary words like `name` are left out, as matches on them mean little.

Not covered yet: public struct fields and interface members, new required trait methods, re-exports removed from an entry point
without the definition changing, and inputs of a GitHub Action's `action.yml`.

## Code quality

Walkdiff flags poor implementations and bad practice in the code a PR adds, under the "Code quality"
category in the Risks tab. These findings never count as security findings.

**Function metrics** are built in and cover Rust, TypeScript, Python, Go, Java, C and C++. A function is flagged when
the PR adds it over a limit, pushes it over one, or makes one already over the limit at least 20%
worse. The Changes tab also shows each modified function's complexity change. Test code is left out.

| Metric | Limit |
| --- | --- |
| Complexity (decision points) | 15 |
| Nesting depth | 4 |
| Lines | 80 |
| Parameters | 6 |

**Three scanners** add to this. None of them use the network. oxlint and jscpd install with Walkdiff, at versions pinned in its lockfile, and Ruff is optional:

```bash
brew install ruff
```

| Scanner | Finds | Reads |
| --- | --- | --- |
| Ruff | Likely bugs and bad practice in Python (rules `F`, `B`, `E7`, `E9`) | Changed files |
| oxlint | Likely bugs in TypeScript and JavaScript | Changed files |
| jscpd | New code of 10 lines or more copied from elsewhere | All source at the PR's head, except tests |

Walkdiff uses its own rules for these scanners and does not read your `ruff.toml`, `.oxlintrc.json` or
`.jscpd.json`, whether they are in the PR or on the default branch. Comments such as `# noqa` and
`eslint-disable` are still honoured, because each one is visible in the diff.

Rust has no linter here: Clippy can run a PR's build scripts and macros, so Walkdiff does not run it on
untrusted code. Design problems, such as a wrong abstraction, are for human or AI review.

To turn all of this off for a repository, add this to `.walkdiff.json` on the default branch:

```json
{ "quality": { "enabled": false } }
```

## Team rules

A `.walkdiff.json` at the repository root adds sensitive areas, excludes paths from risk rules, and can
forbid AI review. A PR is always judged by the version on its merge base, so its own edits to the file
take effect only after merge, and are reported as a finding:

```json
{
  "riskPaths": [{ "pattern": "src/ledger/**", "severity": "high", "reason": "Moves customer funds" }],
  "ignore": ["tests/fixtures/**"],
  "ai": { "allowed": true },
  "feedback": { "url": "https://forms.example.com/walkdiff" }
}
```

## How it works

1. **Providers** (`packages/providers`) parse the URL and read the PR from the host's API, including its merge base.
2. **Engine** (`packages/engine`) fetches only the merge-base and head commits (depth 1) into a cached bare
   repository under `~/.cache/walkdiff/repos`, builds the file list and hunks from `git diff`, classifies noise,
   and parses both versions of each file with tree-sitter (WASM) to extract and compare units
   (`src/syntax`: one small spec per language, a shared walker, token fingerprints for comparison).
   `src/impact` then scans the head commit's source for the changed names and parses the matching files
   to resolve references, `src/risk` runs the risk rules and dependency checks, and `src/ai` builds the
   prompt, calls the model and validates its citations. Git commands whose
   output is parsed run without user and system git config, which can otherwise change the output format.
3. The **review model** (`packages/review-model`) is the JSON contract between the engine and every
   consumer, validated with Zod on both sides.
4. The **CLI** (`packages/cli`) writes the report as one self-contained HTML file, plus `review.json` as
   data, and serves it on `127.0.0.1`. The page also opens directly from disk, which is how CI artifacts
   are used.
5. The **report UI** (`packages/report-ui`) is a React app built with Vite.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build:ui
pnpm --filter @walkdiff/report-ui dev   # needs a review.json in packages/report-ui/public
```

## License

[FSL-1.1-ALv2](LICENSE.md), the Functional Source License. You can use, modify and redistribute this software for any purpose except offering it as a competing commercial product or service, and internal use is explicitly allowed. Each version becomes available under the Apache License 2.0 two years after its release. This is source-available, not an OSI-approved open source license.
