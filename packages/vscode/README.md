# Walkdiff for VS Code

Review GitHub pull requests and GitLab merge requests in VS Code with [Walkdiff](https://github.com/navasvarela/walkdiff): each changed function whole, where the rest of the code uses it, and what looks risky.

## What it does

- **Review this branch's pull request.** With a branch checked out, the extension finds its open PR on GitHub or GitLab and starts a review.
- **Review one waiting for you.** Lists the open PRs that ask you for a review, on the host of the repository you have open.
- **Review one by link.** Paste any PR or MR link.
- **Read the review in the editor.** The Walkdiff view in the activity bar lists your reviews and each one's progress. A finished review opens onto its changed files, with lockfiles and generated files last, and the findings in each file, worst first. Findings about the PR as a whole come first. Clicking a file opens the change in VS Code's diff editor, without checking the PR out; clicking a finding opens it at its line.
- **Comment and submit your review.** In a review's diff, click beside any line the diff shows (or select several) to add a comment. Comments stay pending, kept with this workspace across restarts, until you run **Submit Review…** from the diff's title bar or the review's menu, and pick Comment, Approve or Request changes. A pending comment can be edited or deleted first.
- **Follow the discussion.** The PR's comment threads from GitHub or GitLab appear on their lines. You can reply to a thread or resolve it there; replies post straight away.
- **Open the full report.** Each review links to its report in your browser, with the review path and where changed code is used.

## Posting safely

A review speaks for the commit its report was made from. If the PR gets new commits after that, Walkdiff posts nothing and asks you to analyze it again; your pending comments are kept. A pending comment whose lines are no longer in the diff after that goes in the review's text, naming the lines it was written on, rather than being lost.

Comments go only on lines the diff shows, as on GitHub and GitLab themselves. Threads on code that has since changed aren't on any line, so only the report's Conversation tab shows them.

## How it works

Reviews run in the Walkdiff app on your machine (`npx walkdiff app`), the same one that serves the review list in your browser. The extension finds the running app from the connection file it writes, and starts it in a terminal if it isn't running. Your GitHub or GitLab login stays with the app: the extension never sees a token.

The app needs Walkdiff 0.14.0 or later, which the extension fetches from npm by default, Node.js 22.18 or later, and a login for private repositories: `GITHUB_TOKEN`, the GitHub CLI's login, or `GITLAB_TOKEN`. For GitHub Enterprise or self-managed GitLab, add the host to `WALKDIFF_TRUSTED_GITHUB_HOSTS` or `WALKDIFF_TRUSTED_GITLAB_HOSTS`, as the [configuration guide](https://github.com/navasvarela/walkdiff/blob/main/docs/configuration.md) describes.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `walkdiff.command` | `npx --yes walkdiff@latest` | How the extension runs Walkdiff when it starts the app: `<command> app --no-open`. Use `walkdiff` if you installed it yourself |
| `walkdiff.dataDir` | empty | The app's data directory, if you start it with `--data-dir` |
| `walkdiff.aiReview` | `false` | Ask for the AI review too, if the app has one set up |

`walkdiff.command` and `walkdiff.dataDir` can only be set in your user settings, not a workspace's, so a repository you open can't change what runs.

## Developing

From the repository root:

```sh
pnpm install
pnpm build:vscode
code --extensionDevelopmentPath="$PWD/packages/vscode"
```

To install a build in your own VS Code, package it and install the `.vsix`:

```sh
pnpm --filter walkdiff-vscode package
code --install-extension packages/vscode/walkdiff-vscode-0.1.0.vsix
```

The extension is bundled into `dist/extension.cjs` with rolldown. Its logic that doesn't need VS Code (the connection file, the API client, the rows of the reviews view) has unit tests that run with the rest: `pnpm test`. The app's API is described in [docs/app-api.md](https://github.com/navasvarela/walkdiff/blob/main/docs/app-api.md).
