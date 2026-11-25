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

1. Open a PR that prepares the release. `node scripts/prepareRelease.ts 0.5.0` bumps `version` in `package.json` and moves every pinned version in the docs, templates and website to the new one. It refuses a version that isn't above the current one, and stops before changing anything if a file has lost its pin. Then add the version's section to the changelog, written from the PRs merged since the last tag, which the script lists when the section is missing. Other PRs don't edit the changelog: it only describes released versions.
2. Merge it, then tag the merge commit with a signed tag, such as `git tag -s v0.5.0 -m "Walkdiff 0.5.0"`, and push the tag.
3. Approve the `npm` environment when the Release workflow asks. It checks the tag matches the version and the changelog has its section, runs the checks, builds the package and publishes it with provenance.
4. The workflow then publishes the GitHub release, with the version's changelog section as its notes. If you've already written a release for the tag by hand, it's left as it is. To preview the notes, run `node scripts/releaseNotes.ts v0.5.0`.
5. Last, it moves the major version tag, such as `v0`, to the release, so the GitHub Action's users who pin `@v0` get it. It's only moved to the newest release of its major, so re-running an old release leaves it where it is. It's a lightweight tag that moves; the signed `vX.Y.Z` tags are the ones to verify. `node scripts/majorTag.ts v0.5.0 $(git tag)` says what it would move.

## Checking a package

`npm view walkdiff --json` shows each version, and npmjs.com shows a provenance badge linking a version to the commit and workflow run that built it. `npm audit signatures` checks the signatures of what you installed.

## The VS Code extension

The extension in `packages/vscode` has its own version and its own tags, such as `vscode-v0.3.0`. Pushing one starts `.github/workflows/release-vscode.yml`, which publishes it to the VS Code Marketplace, to Open VSX if a token is set, and as a GitHub release with the `.vsix` attached. The npm release only starts from tags like `v0.14.0`, so neither starts the other.

### One-time setup

The Marketplace accepts the extension from a Microsoft Entra identity that trusts this workflow through OIDC, so no Marketplace token is stored anywhere. Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) has the current screens for each step.

1. In Microsoft Entra ID, create an app registration (or a user-assigned managed identity) for publishing. It needs no Azure subscription and no roles.
2. Give it a federated credential for GitHub Actions:
   - Organization: `navasvarela`
   - Repository: `walkdiff`
   - Entity type: Environment, named `vscode`
3. Add the identity as a member of the `navasvarela` publisher on [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), with the Contributor role.
4. In the GitHub repository's settings:
   - Under **Environments**, create `vscode` and add yourself as a required reviewer, so every publish waits for your approval.
   - Under **Secrets and variables → Actions → Variables**, add `VSCODE_MARKETPLACE_CLIENT_ID` and `VSCODE_MARKETPLACE_TENANT_ID`, the identity's client and tenant IDs. They aren't secrets.
   - To publish to Open VSX too, add an Open VSX access token as the `OVSX_PAT` secret of the `vscode` environment. Without it, the workflow skips Open VSX.

### Each release

1. Open a PR that sets the new `version` in `packages/vscode/package.json`, and the version in the README's install example.
2. Merge it, then tag the merge commit with a signed tag, such as `git tag -s vscode-v0.3.0 -m "Walkdiff for VS Code 0.3.0"`, and push the tag.
3. Approve the `vscode` environment when the workflow asks. It checks the tag matches the version, runs the checks, packages the extension and publishes it. The Marketplace checks a new version for a few minutes before it's live.

`pnpm --filter walkdiff-vscode package` builds the same `.vsix` locally, after `pnpm build:ui`.

## The Neovim plugin

The plugin in `packages/nvim` is installed straight from this repository, so a release is a tag people can pin, such as `nvim-v0.2.0`; nothing is published elsewhere, and no workflow starts from these tags.

1. Open a PR that moves the pinned tag in the plugin's README install examples to the new one.
2. Merge it, then tag the merge commit with a signed tag, such as `git tag -s nvim-v0.2.0 -m "Walkdiff for Neovim 0.2.0"`, and push the tag.
3. Publish a GitHub release for the tag, not marked as the latest release so the npm release keeps that place: `gh release create nvim-v0.2.0 --verify-tag --latest=false --title "Walkdiff for Neovim 0.2.0" --notes-file notes.md`.
