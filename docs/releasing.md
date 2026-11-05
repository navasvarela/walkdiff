# Releasing Walkdiff

## One-time setup on npm

Do this once, before the first release that publishes to npm.

1. Create an npm account with two-factor authentication, and make sure you own the `walkdiff` name. Publishing a first version by hand claims it, or npm can reserve it for you.
2. On npmjs.com, open the `walkdiff` package's settings, and under **Trusted publishing** add GitHub Actions with:
   - Organization or user: `navasvarela`
   - Repository: `walkdiff`
   - Workflow filename: `release.yml`
   - Environment: `npm`
3. In the GitHub repository's settings, open **Environments**, create `npm`, and add yourself as a required reviewer. Every publish then waits for your approval.
4. In the package's npm settings, set publishing access to require trusted publishing, which turns off publishing with tokens.

No npm token is stored anywhere: npm checks the workflow's identity on each publish.

## Each release

1. Open a PR that bumps `version` in `package.json`, points the docs and templates at the new tag, and adds the version's section to the changelog, written from the PRs merged since the last tag (`git log vPREVIOUS..origin/main`). Other PRs don't edit the changelog: it only describes released versions.
2. Merge it, then tag the merge commit with a signed tag, such as `git tag -s v0.5.0 -m "Walkdiff 0.5.0"`, and push the tag.
3. Approve the `npm` environment when the Release workflow asks. It checks the tag matches the version, runs the checks, builds the package and publishes it with provenance.
4. Publish the GitHub release with notes.

## Checking a package

`npm view walkdiff --json` shows each version, and npmjs.com shows a provenance badge linking a version to the commit and workflow run that built it. `npm audit signatures` checks the signatures of what you installed.
