# Adding a check

A check is one object the review runs, listed in
[`packages/engine/src/risk/checks/registry.ts`](../packages/engine/src/risk/checks/registry.ts).
`assessRisk` runs every check in the registry. It then merges their findings, the checks they ran
and the ones they couldn't run into the report, so a new check needs no other wiring in the engine.

## The interface

A `Check` ([`check.ts`](../packages/engine/src/risk/checks/check.ts)) has a `step`, which the progress
display shows while it runs, and a `run` method:

```ts
const MY_CHECK: Check = {
  step: AnalysisStep.ScanningCode,
  run: async ({ request, config, scanned }) => ({
    findings: myRules(scanned),
    checksRun: [{ name: "My check", detail: "what it looks for" }],
    notChecked: [],
  }),
}
```

`run` gets a `CheckContext`:

| Field | What it is |
| --- | --- |
| `request` | The review: commits, changed files, parsed functions, whether the network may be used, the checks turned off in Settings, and how to run a scanner |
| `config` | `.walkdiff.json` at the merge base, so a PR can't change the rules it's checked by |
| `scanned` | Changed files the config doesn't ignore, with their diff and head text |
| `pipelineFiles()` | CI files at the head, read once however many checks ask |

A check reports what it couldn't do instead of failing silently. If a scanner isn't installed, the
network is off, or a file can't be read, add a `{ check, reason }` to `notChecked`, and the Risks tab
lists it.

## Findings

Describe each rule once as a `RuleDescription`: an id, category, severity, title and detail. Then make
findings with `findingAt(rule, path, line, evidence)` from
[`scannedFile.ts`](../packages/engine/src/risk/scannedFile.ts).

- **Ids:** prefix them by check, as in `supply-chain.tls-off`.
- **Added lines:** `addedLines(diff)` gives the lines a PR adds. Judging only those keeps a check
  from flagging code that was already there.
- **Comments and strings:** for rules on code, `isInsideCommentOrString` skips matches inside them.

The registry's order matters: where two checks flag the same line, the first is kept. Add a new check
after the built-in rules.

## Rules for a language

A risky API, an error-handling pattern or a web framework's routes belong in the language's module,
not in the check: see [Adding a language](adding-a-language.md).

## A check people can turn off

Checks that need something installed, or send data off the machine, can be turned off in Settings:

1. Give it a `CheckId` in [`review-model/src/settings.ts`](../packages/review-model/src/settings.ts).
2. Describe it in [`checkCatalog.ts`](../packages/engine/src/risk/scanners/checkCatalog.ts). If it
   sends anything off the machine, say what, where and when in `sends`. Settings builds its "What
   leaves your machine" list from those entries.
3. In `run`, check `request.disabledChecks.has(...)`. When it's turned off, report it in `notChecked`
   with `TURNED_OFF_IN_SETTINGS`. Check `request.network` before anything goes over the network.

## Still outside the check

A finding's category, such as `supplyChain`, is a fixed list in the report format. A new category
still needs:

- an entry in `RiskCategory`;
- an entry in `SECURITY_CATEGORIES` if it counts towards security;
- a label in report-ui's `risks.ts`;
- a sentence in `reviewPlan.ts`;
- a rule-id prefix in review-model's `checkSummary.ts`, so findings count under the check that raised them.

Making categories data that checks declare is the next step.

## Testing

Test the rules directly, with diffs built in the test, as
[`supplyChain/configRules.test.ts`](../packages/engine/src/risk/supplyChain/configRules.test.ts) does.
For checks that read git, add one end-to-end test over a temporary repository, as
[`supplyChain/scanSupplyChain.test.ts`](../packages/engine/src/risk/supplyChain/scanSupplyChain.test.ts)
does. Cover what the check flags, what it leaves alone, and what it reports when it can't run.
