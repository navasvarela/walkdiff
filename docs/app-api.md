# The local app's API

`walkdiff app` serves a JSON API on the loopback interface. Its own page uses it, and so can an editor plugin or a script: find a PR to review, add it, wait for it, read the report, open a changed file at either side of the PR, then post the review. This page describes how to find the app, how to call it, and what each endpoint returns.

The API only listens on `127.0.0.1`. Anything that can read your connection file can act with your GitHub or GitLab login, so the file is readable by you alone.

## Finding the app

While it runs, the app writes `app.json` to its data directory: `$XDG_DATA_HOME/walkdiff`, which is `~/.local/share/walkdiff` by default, or the directory given with `--data-dir`.

```json
{
  "url": "http://127.0.0.1:4317/",
  "apiKey": "64 hex characters",
  "apiVersion": 1,
  "version": "0.13.0",
  "pid": 41873
}
```

| Field | Meaning |
| --- | --- |
| `url` | Where the app listens. Endpoints below are relative to it. |
| `apiKey` | The key every request must send. A new one is made each time the app starts. |
| `apiVersion` | The version of this API. See [Versions](#versions). |
| `version` | The Walkdiff version that's running. |
| `pid` | The app's process. |

The app removes the file when it stops. If it crashed, the file is left behind and points at nothing, so check the connection with `GET api/info` before relying on it. If there's no file, or `api/info` doesn't answer, ask the user to run `npx walkdiff app`.

## Calling it

Every request sends the key in the `x-walkdiff-key` header, and bodies are JSON:

```sh
curl -H "x-walkdiff-key: $KEY" http://127.0.0.1:4317/api/info
```

The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; HTTP clients set it from the URL. A wrong key gets `401`, which also means the app restarted since you read the file: read it again.

Errors come back as `{ "error": "…" }`, written to be shown to the user as they are.

## Versions

`apiVersion` goes up when an endpoint is removed or changes in a way an existing client would misread. Adding endpoints, or adding fields to a response, doesn't change it, so ignore fields you don't know. A client should refuse an `apiVersion` it wasn't written for and ask the user to update one or the other.

The report has its own version, `reportSchemaVersion`, which `GET api/info` returns too. It is the `schemaVersion` of `review.json`, defined in `packages/review-model`.

## Endpoints

### `GET api/info`

Which API and report format the app speaks.

```json
{ "apiVersion": 1, "reportSchemaVersion": 11, "version": "0.13.0" }
```

### `GET api/pull-requests?remote=<url>&branch=<name>`

The open PRs from a branch of the repository: usually one, for the branch checked out in the editor. `remote` is the repository's git remote, as `git remote get-url origin` prints it, over HTTPS or SSH. Answers a list of PR listings (`pullRequestListingSchema` in `packages/review-model`):

```json
[
  {
    "url": "https://github.com/acme/app/pull/7",
    "host": "github",
    "displayName": "acme/app#7",
    "repository": "acme/app",
    "number": 7,
    "title": "Cap retries",
    "author": "dev",
    "draft": false,
    "updatedAt": "2026-11-20T09:30:00Z"
  }
]
```

There can be several, into different base branches, or none. Only PRs from the repository's own branch are listed, not from a fork's branch of the same name. To review one, send its `url` to `POST api/reviews`.

The remote's host must be github.com, gitlab.com, or a host listed in `WALKDIFF_TRUSTED_GITHUB_HOSTS` or `WALKDIFF_TRUSTED_GITLAB_HOSTS`, since a remote doesn't show which kind of host it is; any other is `400`. A remote over SSH is taken to have its web pages over HTTPS on the same host name. When the host refuses, such as for a token that can't read the repository, the answer is `502` with the host's reason.

### `GET api/review-requests?remote=<url>`

Open PRs anywhere on the remote's host that ask you for a review, most recently updated first, up to 50, as the same listings. On GitHub that includes requests to your teams. GitLab keeps a reviewer on a merge request after they review it, so there the list also has open merge requests you've already reviewed.

This needs your login on that host: without one the answer is `403`, with what to set.

### `GET api/reviews`

Every review in the list, newest first. Each is a review summary (`reviewSummarySchema` in `packages/review-model/src/schema.ts`). The fields a client most often needs:

| Field | Meaning |
| --- | --- |
| `id` | The review's id in the app, used by every endpoint below |
| `url` | The PR or MR |
| `displayName` | `owner/repo#12` or `group/project!12` |
| `status` | `queued`, `analyzing`, `ready` or `failed` |
| `step` | While analyzing, the step it's on |
| `error` | Why the last analysis failed |
| `hasReport` | Whether there's a report to read. A failed refresh keeps the earlier one. |
| `reportHead` | `{ headSha, baseRef }`: the commit the report was made from |
| `securityLevel`, `findings`, `unitsToReview` | Counts shown in the list |

### `POST api/reviews`

Adds a PR or MR and starts analyzing it. Analyses run one at a time.

```json
{ "url": "https://github.com/acme/app/pull/7", "ai": false }
```

`ai` asks for the AI review as well, when one is set up. Answers `202` with the new review's summary. Adding a PR that's already in the list analyzes it again and returns that review. Poll `GET api/reviews` until its `status` is `ready` or `failed`; once a second is plenty.

### `POST api/reviews/:id/refresh`

Analyzes the review again, after new commits. Answers `202` with its summary.

### `DELETE api/reviews/:id`

Removes the review from the list.

### `GET api/reviews/:id/report`

The review's report as data: the same `review.json` the report page is drawn from (`reviewModelSchema` in `packages/review-model`). It holds the PR's details and commits, every changed file with its diff and changed units, where other code uses them, the risks found, the review path and the AI review. `404` when the review has no report yet.

### `GET api/reviews/:id/file?side=base|head&path=<path>`

One changed file's text at the PR's merge base (`base`) or its head (`head`), so a client can show the change in its own diff view.

```json
{ "path": "src/retry.ts", "side": "head", "commit": "3f1c…", "text": "export const retries = 5\n" }
```

Only files the PR changes can be read, by their path or, for a renamed file, their previous path. Anything else is `404`, as is a file that doesn't exist on that side, such as an added file at `base`. A bad `side` or a missing `path` is `400`.

### `GET api/reviews/:id/conversation`

The PR's discussion, read from the host: `reviewers` with each one's latest verdict, the comment `threads`, and `truncated` when the host had more than Walkdiff read (`conversationSchema` in `packages/review-model/src/conversation.ts`).

### `POST api/reviews/:id/submit`

Posts a review to the PR (`submitReviewSchema` in `packages/review-model/src/conversation.ts`):

```json
{
  "event": "approve",
  "body": "Looks good.",
  "headSha": "3f1c…",
  "comments": [
    { "path": "src/retry.ts", "previousPath": "src/retry.ts", "line": 1, "label": "retries", "range": null, "body": "Why 5?" }
  ]
}
```

`event` is `comment`, `approve` or `requestChanges`. `headSha` must be the report's `reportHead.headSha`: when the PR has had new commits since, nothing is posted and the answer is `409`, so a review never covers code the reviewer didn't see. `line` is a line the PR added, on the new side; use `range` for other lines. Answers `201` with `{ "url": "…" }`, the posted review. When the host refuses, such as GitHub not letting you approve your own PR, the answer is `502` with the host's reason.

### `POST api/reviews/:id/threads/:threadId/reply`

Replies to a comment thread: `{ "body": "Fixed in 3f1c." }`.

### `POST api/reviews/:id/threads/:threadId/resolve`

Resolves or reopens a thread: `{ "resolved": true }`.

The app's page also uses endpoints for stacks, coverage and settings. They aren't covered by `apiVersion` yet and may change.
