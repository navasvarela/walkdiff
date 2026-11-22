# Walkdiff for VS Code

Review GitHub pull requests and GitLab merge requests in VS Code with [Walkdiff](https://github.com/navasvarela/walkdiff): each changed function whole, where the rest of the code uses it, and what looks risky.

## What it does

- **Review this branch's pull request.** With a branch checked out, the extension finds its open PR on GitHub or GitLab and starts a review.
- **Review one waiting for you.** Lists the open PRs that ask you for a review, on the host of the repository you have open.
- **Review one by link.** Paste any PR or MR link.
- **Read the review in the editor.** The Walkdiff view in the activity bar lists your reviews and each one's progress. A finished review opens onto its changed files, with lockfiles and generated files last, and the findings in each file, worst first. Findings about the PR as a whole come first. Clicking a file opens the change in VS Code's diff editor, without checking the PR out; clicking a finding opens it at its line.
- **Open the full report.** Each review links to its report in your browser, with the review path, where changed code is used, and the Conversation tab for posting your review.

## How it works

Reviews run in the Walkdiff app on your machine (`npx walkdiff app`), the same one that serves the review list in your browser. The extension finds the running app from the connection file it writes, and starts it in a terminal if it isn't running. Your GitHub or GitLab login stays with the app: the extension never sees a token.

The app needs Node.js 22.18 or later, and a login for private repositories: `GITHUB_TOKEN`, the GitHub CLI's login, or `GITLAB_TOKEN`. For GitHub Enterprise or self-managed GitLab, add the host to `WALKDIFF_TRUSTED_GITHUB_HOSTS` or `WALKDIFF_TRUSTED_GITLAB_HOSTS`, as the [configuration guide](https://github.com/navasvarela/walkdiff/blob/main/docs/configuration.md) describes.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `walkdiff.command` | `npx walkdiff` | How the extension runs Walkdiff when it starts the app: `<command> app --no-open` |
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

The extension is bundled into `dist/extension.cjs` with rolldown. Its logic that doesn't need VS Code (the connection file, the API client, the rows of the reviews view) has unit tests that run with the rest: `pnpm test`. The app's API is described in [docs/app-api.md](../../docs/app-api.md).
