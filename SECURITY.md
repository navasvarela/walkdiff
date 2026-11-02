# Security policy

Walkdiff reads private code and uses tokens that can reach it, so you should be able to check what it does with both. This page says what Walkdiff guarantees, what it doesn't, and how to verify it.

> **Status: draft.** Walkdiff is pre-release software and hasn't had an independent security audit.

## Reporting a vulnerability

[Report it privately through GitHub](https://github.com/navasvarela/walkdiff/security/advisories/new). Please don't open a public issue, and leave real secrets and private code out of your report.

Walkdiff is maintained by one person, so these are goals, not contractual promises:

| Step | Goal |
| --- | --- |
| First reply | 3 working days |
| Assessment | 10 working days |
| Fix for a confirmed high or critical issue | 30 days |

Only the latest release is supported. Testing against your own installation is welcome. Please don't test against other people's repositories, accounts or reports.

## What Walkdiff guarantees

Each guarantee describes the latest release and has an automated test or setting behind it.

### Your code

| Guarantee | How it's enforced |
| --- | --- |
| Walkdiff never builds, installs or runs code from a PR | It only reads commits from a bare repository and parses them. The GitHub Action doesn't check out the PR |
| Code isn't sent to any AI service unless you ask | AI review needs `--ai`, or the checkbox in the app |
| A team can limit where code goes | `"ai": { "providers": ["local"] }` in `.walkdiff.json`. Both the merge base and the PR have to allow the provider |
| A repository can forbid AI review | `"ai": { "allowed": false }` in `.walkdiff.json`. A PR can't remove this, because if either version forbids it, it's blocked |
| Walkdiff has no telemetry and no server of its own | It collects no usage data, and the only network destinations are listed below |
| A report can't contact anything outside the app | Every report carries a Content Security Policy that blocks network requests, so script injected through a PR has nowhere to send data. In the app, a report can call the app itself, and nothing else |
| Walkdiff only changes something on the host when you press a button | Posting a review, replying and resolving each need a click, and only happen in the local app. The command line and reports opened from a file can't do them, and CI only posts its summary comment |
| A review only speaks for the code you read | Walkdiff refuses to post if the PR has new commits since the report was made, and the review is tied to that commit |
| A page can't aim your token at another host | The host comes from the saved review, never from the request, and these actions need the key created each time the app starts |
| Local servers aren't reachable from your network | They listen only on `127.0.0.1` and refuse other host names, which blocks DNS rebinding |
| Local files are private to your user account | Reports, cached repositories and the review list are created for your user only, and the default folders are closed to other users |

### Your credentials

| Guarantee | How it's enforced |
| --- | --- |
| A token only goes to hosts you trust | `github.com`, `gitlab.com` and hosts you list. See [trusted hosts](docs/configuration.md#tokens-and-trusted-hosts) |
| A token doesn't go to the wrong kind of host, or over plain http | Whole origins are compared, for each kind of token |
| A redirect can't carry a token to another host | Walkdiff refuses cross-host API redirects, and git doesn't follow redirects while it holds a token |
| AI keys aren't stored | They come from the environment, and the settings have no field for them |
| An AI key and your code only go over https, or to this machine | Other addresses are refused, and redirects aren't followed |
| Tokens stay out of command lines and repository config | They reach git through its environment |
| Third-party scanners don't get your tokens | They run with a minimal environment, on a temporary copy of the changed files |
| Bundled scanners are pinned | oxlint and jscpd install at exact versions from the lockfile, which CI enforces, so an update reaches you only through a Walkdiff change |
| Walkdiff doesn't store your tokens | It reads them from the environment or the GitHub CLI each time |

### Secrets in pull requests

| Guarantee | How it's enforced |
| --- | --- |
| Findings don't show a detected secret | Evidence is redacted in the report and left out of the PR comment |
| Known credential formats are redacted from AI prompts | Prompts pass through redaction just before sending, including private key bodies |
| Credential files aren't sent to AI at all | `.env`, `*.pem`, `*.key`, `.npmrc` and similar are left out by name |

### Tampering with results

| Guarantee | How it's enforced |
| --- | --- |
| A PR can't relax its own rules | `.walkdiff.json` is read from the merge base, and editing it is itself a finding |
| A PR can't silence scanners | Suppression comments are ignored, and scanner config files in the PR aren't used |
| A PR can't instruct the AI to act | The AI has no tools and can only return a structured review. Every statement must cite lines it was shown, and the rest is discarded |

## What Walkdiff doesn't guarantee

- **"No security findings" doesn't mean a change is safe.** Walkdiff runs pattern and secret scans on the lines a PR adds. It doesn't trace data through the code, reason about permissions or run anything, so it isn't a security audit. The report lists the checks that didn't run.
- **Secret detection isn't complete.** Redaction recognises known formats and common assignments. A secret in an unusual format can still reach an AI prompt, so don't use `--ai` on a PR you know contains secrets.
- **The Changes tab shows the code as it is.** A secret in a PR is redacted from findings, but still appears in the diff, in the report and in `review.json`.
- **Prompt injection can mislead the AI review.** Someone writing a PR can try to influence what it says, so treat its output as a hint and not as a verdict.
- **Coverage can be faked.** In CI, a PR's own code produces the coverage report, so someone trying to deceive could fake it. It helps honest reviewers, and isn't a security control.
- **Reference finding is by name and syntax,** so the Impact tab can miss callers or match the wrong ones.
- **A flaw in the report page could post as you.** In the app, a report can call the API that posts reviews, using your token. PR text is always shown as text, never as HTML, but if script ever got onto that page, it could post comments or approve in your name, on that review's host only.
- **Walkdiff doesn't protect you from your own machine.** Files are stored unencrypted, and anything running as your user can read them.

## What leaves your machine

| Destination | What is sent | When | How to stop it |
| --- | --- | --- | --- |
| The PR's host | Your token if the host is trusted, and requests for the PR and its code. Your comments and decisions when you post a review | Always; posting only when you press the button | - |
| [OSV](https://osv.dev) | Names and versions of dependencies changed in the PR, **including private package names** | By default | `--offline` |
| npm, PyPI and crates.io | Names of new direct dependencies, **including private package names** unless listed in `dependencies.private` | When a PR adds a dependency | `--offline`, Settings, or `dependencies.private` |
| Semgrep registry | A rule download; code isn't uploaded | During a review, unless turned off | `--offline`, or an empty rule list |
| Your AI provider (Anthropic by default, or the address in `ANTHROPIC_BASE_URL` if that's set) | Changed code, and the PR's title and description | Only with `--ai` or the app's AI option | Leave it off, forbid it in `.walkdiff.json`, or use a local model |

You choose the AI provider, so check how it handles your data. For Anthropic, see [its privacy documentation](https://privacy.anthropic.com).

## The report in CI

The report isn't hosted by Walkdiff. It's a single HTML file stored by your own CI system.

| | GitHub Actions | GitLab CI |
| --- | --- | --- |
| **Stored as** | A workflow artifact, in GitHub's storage | A job artifact, on your GitLab instance |
| **Private repository** | People with read access to the repository | Depends on the project's job artifact access |
| **Public repository** | **Any signed-in GitHub user** | **Public, unless you restrict it** |
| **Kept for** | 14 days, set with `retention-days` | 14 days, set with `expire_in` |

For the people who can already read the repository, the report adds little exposure, but keep these in mind:

- **Public repositories:** reports are effectively public. That includes any AI review output, so assume anything in the PR is public too.
- **Secrets stay until the artifact expires:** removing a secret from a PR doesn't remove it from reports already generated. If a secret was committed, revoke it, then delete the workflow run's artifact.
- **The download address:** when someone signed in opens the link, GitHub redirects to a temporary storage address. Anyone who has that address can use it until it expires, so don't paste it anywhere.
- **Downloaded copies:** a report someone saved stays on their machine, with no expiry and no access control.
- **The PR comment:** it shows finding titles and file paths, never code or evidence. Everyone who can see the PR sees it, and it may reach them by email.
- **GitLab:** check the project's visibility and its [job artifact settings](https://docs.gitlab.com/ci/jobs/job_artifacts/), especially "Public pipelines".

## Using Walkdiff safely in CI

- **Pin the action to a release tag or, better, a full commit SHA**, not `@main`, so a later change can't reach your CI without your review. Release tags are signed.
- **Use the narrowest token.** The default `github.token` with `contents: read` and `pull-requests: write` is enough.
- **Don't use `pull_request_target`.** Use `on: pull_request`, as in the [pilot guide](docs/pilot.md).
- **Keep the Anthropic key out of fork PRs.** GitHub doesn't give secrets to `pull_request` runs from forks by default, so keep it that way.

## How the project is built

| Measure | Status |
| --- | --- |
| Signed commits required on `main` | On, enforced by a repository ruleset |
| Changes to `main` go through a pull request; no force-push or deletion | On |
| CodeQL code scanning | On |
| GitHub secret scanning and push protection | On |
| Dependabot alerts | On |
| Lockfile enforced in CI (`--frozen-lockfile`) | On |
| Dependency install scripts blocked | On, pnpm's default |
| Scanners downloaded by `pnpm install` must match pinned hashes, with no package setup code run | On |
| GitHub Actions pinned to commit SHAs | On |
| Default workflow token is read-only | On |

**Commit history:** `main` includes early commits that are unsigned, or signed with a key GitHub doesn't recognise. The signing requirement applies to new commits, because rewriting published history would break existing links.
