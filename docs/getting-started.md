# Getting started

## Install

You need Node.js 22.18 or newer, and git.

```bash
npm install --global walkdiff
```

Or skip installing, and put `npx` in front of each command, as in `npx walkdiff app`. The first review also installs the security scanners Walkdiff runs; `walkdiff setup` does it in advance.

## Your first report

```bash
walkdiff review https://github.com/owner/repo/pull/123
```

Walkdiff fetches the change, analyzes it and prints a local address to open. GitLab works the same way, with a merge request link. Press Ctrl+C when you are done.

The report opens on a brief, with what to check and where to start:

1. **Start the review.** Walkdiff takes you through the changes that matter most, one at a time, and says why each one is there.
2. **Mark what you've reviewed** and leave comments as you go: on a whole change, or on exact lines by clicking a line number, with shift-click to pick several. The side panel shows your progress and links to every change.
3. **Finish.** The last screen shows what you reviewed, what's left, and what Walkdiff couldn't check. In the app, you can post your review from here. Elsewhere, copy your comments.

Everything else is under **All changes**:

- **Changes:** each changed function or type, whole, before and after.
- **Impact:** where other code uses what changed, and which of those callers the PR did not touch.
- **Risks:** a summary of security findings, the findings, the checks that ran and the checks that did not. Findings include [breaking changes](../README.md#breaking-changes), which never change the security level.
- **AI review:** a reading order and questions, only if you ask for it with `--ai`.

"No security findings" means the checks that ran found nothing on the lines this PR adds. It isn't a security audit and doesn't mean the change is safe, so see which checks ran.

## Private repositories

Walkdiff needs a token that can read the repository. If you use the GitHub CLI:

```bash
GH_TOKEN=$(gh auth token) walkdiff review https://github.com/owner/repo/pull/123
```

For GitLab, create a token with the `read_api` and `read_repository` scopes:

```bash
GITLAB_TOKEN=<token> walkdiff review https://gitlab.com/group/project/-/merge_requests/123
```

## Keep track of several reviews

```bash
walkdiff app
```

This opens a list at `http://127.0.0.1:4317/` in your browser. Use `--no-open` to leave your browser alone. Paste a link to add a review. If you're signed in with the GitHub CLI, the app uses that login for GitHub. For GitLab, set `GITLAB_TOKEN` before starting it.

### Review a stack together

A stack is a chain of PRs, each built on the one below it: `add-schema` into `main`, `add-parser` into `add-schema`, and so on. When you add one PR from a stack, the app notices while it analyzes it, and offers the rest:

> **Part of a stack of 3** into `main`: #11 Add schema → **#12 Add parser (this one)** → #13 Wire CLI

**Review the whole stack** adds the missing PRs and shows the stack as one card, bottom first. PRs already on your list join it without being analyzed again. **Not now** hides the offer. A PR that joins the stack later is offered on its own.

- **What's found:** the app uses GitHub's and GitLab's own stacks where the PR is in one. Otherwise it follows branches, so stacks made with other tools are found too. Only open PRs from the same repository count, up to 20. Where two PRs build on the same one, the chain stops there, and the app names the PRs it left out.
- **AI review:** the offer has its own AI box, starting from the choice you made for the PR you added. It applies only to the PRs the stack adds to your list.
- **Each report is the PR's own change**, from where it branched off the PR below it, so you don't see the lower PRs' code again. A strip at the top of each report links to the PRs below and above it.
- **The card asks the host when it opens:** which PRs have new commits or were retargeted (as when the one below merged), who approved, and which merged or closed. **Refresh changed** analyzes again only the PRs that changed. Your progress in each report carries over, so only changed code comes back unreviewed. Until you open a refreshed report, the list says it changed since you reviewed it.
- **Ungroup** turns the card back into separate reviews and doesn't offer the stack again.

## Post your review

In the app, the finish screen posts your comments and your decision to the PR: Comment, Approve or Request changes. The Conversation tab shows existing threads, where you can reply and resolve them. Nothing is posted until you press the button.

Your token needs write access: `pull-requests: write` on GitHub, or the `api` scope on GitLab. A GitHub CLI login usually already has it.

## Show test evidence

Walkdiff shows whether each change's lines ran in tests when it has a coverage report for the PR's latest commit, in LCOV or Cobertura format. You don't have to set anything up per PR. It looks in this order:

1. **A report you attach.** In the app, choose **Attach coverage** on a review. Pick several files if your repository has one per package. The report updates at once, with no restart and no new analysis, and applies only to that PR. It's dropped when the PR gets new commits.
2. **CI artifacts.** Walkdiff checks the runs for the PR's latest commit: GitHub Actions artifacts whose name contains `cov`, `lcov` or `cobertura`, or on GitLab, jobs that declare `artifacts:reports:coverage_report` or have such a name. GitLab's API only serves a job's `artifacts:paths`, so keep the report there too. A GitHub fine-grained token needs **Actions: read**.
3. **A report the PR adds or updates**, such as one CI commits to a folder. Reports that the PR didn't change are ignored, because they describe an older commit.

Named `lcov.info`, `*.lcov`, `cobertura*.xml` or `coverage*.xml`, reports are found on their own. For other names, add globs to `coverage.paths` in `.walkdiff.json`. On the command line, `--coverage` names a file directly.

A report from CI or the PR is produced by the PR's own code, so treat it as evidence, not proof. Changes whose lines didn't run rank higher.

```bash
walkdiff review https://github.com/owner/repo/pull/123 --coverage coverage/lcov.info
```

A report you attach or name has to come from the PR's latest commit, or the line numbers won't match. In CI, use the Action's `coverage-file` input or the GitLab template's `WALKDIFF_COVERAGE` variable.

## Security scanners

Walkdiff installs Semgrep, gitleaks, osv-scanner, Ruff and zizmor on its first run, or with `walkdiff setup`, at pinned versions and just for Walkdiff, in `~/.cache/walkdiff/scanners`, on macOS and Linux. Semgrep needs Python 3.10 or later. If one can't be installed, Walkdiff still runs, and reports list it as not run.

On other systems, install them yourself and Walkdiff finds them on your `PATH`.

## Next steps

- [Set options and team rules](configuration.md)
- [Add Walkdiff to CI](pilot.md)
- [Fix a problem](troubleshooting.md)
