import { z } from "zod"
import { AnalysisStep } from "./analysisSteps.ts"
import { stackOfferSchema, stackPlaceSchema } from "./stack.ts"

/**
 * The review model is the contract between the analysis engine and every consumer
 * (report UI, CI, future server). Bump the version on any breaking change so a
 * report UI can refuse a model it does not understand instead of misrendering it.
 */
export const REVIEW_MODEL_SCHEMA_VERSION = 11

export const GitHostKind = { GitHub: "github", GitLab: "gitlab" } as const
export type GitHostKind = (typeof GitHostKind)[keyof typeof GitHostKind]

// SHA-1 object names are 40 hex digits; repositories using SHA-256 have 64.
export const commitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .brand<"CommitSha">()
export type CommitSha = z.infer<typeof commitShaSchema>

/** The commits and branches every change under review has, hosted or not. */
const changeFields = {
  title: z.string(),
  description: z.string(),
  author: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
  /** The diff is always computed from the merge base, matching what GitHub and GitLab show. */
  mergeBaseSha: commitShaSchema,
}

/** A pull request or merge request on its host, where comments and approvals can be posted. */
export const hostedPullRequestSchema = z.object({
  host: z.enum(GitHostKind),
  url: z.url(),
  /** The repository's web page, for linking to files at a commit. */
  repositoryWebUrl: z.url(),
  number: z.number().int().positive(),
  ...changeFields,
})
export type HostedPullRequest = z.infer<typeof hostedPullRequestSchema>

export const LOCAL_CHANGE_HOST = "local"

/**
 * A branch reviewed on its author's machine before it's pushed (`walkdiff review --local`). It
 * has no host, so no link, number or web page to link files to, and nowhere to post a review.
 */
export const localChangeSchema = z.object({
  host: z.literal(LOCAL_CHANGE_HOST),
  /** The folder the repository is in, which names it in the report. */
  repositoryName: z.string(),
  ...changeFields,
})
export type LocalChange = z.infer<typeof localChangeSchema>

/** What's under review: still named for pull requests, which most reviews are. */
export const pullRequestSchema = z.discriminatedUnion("host", [hostedPullRequestSchema, localChangeSchema])
export type PullRequest = z.infer<typeof pullRequestSchema>

export function isHostedPullRequest(pullRequest: PullRequest): pullRequest is HostedPullRequest {
  return pullRequest.host !== LOCAL_CHANGE_HOST
}

const lineNumberSchema = z.number().int().positive()

export const DiffLineKind = { Context: "context", Added: "added", Removed: "removed" } as const
export type DiffLineKind = (typeof DiffLineKind)[keyof typeof DiffLineKind]

export const diffLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(DiffLineKind.Context),
    content: z.string(),
    oldLine: lineNumberSchema,
    newLine: lineNumberSchema,
  }),
  z.object({ kind: z.literal(DiffLineKind.Added), content: z.string(), newLine: lineNumberSchema }),
  z.object({ kind: z.literal(DiffLineKind.Removed), content: z.string(), oldLine: lineNumberSchema }),
])
export type DiffLine = z.infer<typeof diffLineSchema>

export const hunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Text git prints after the closing `@@`, usually the enclosing function signature. */
  section: z.string(),
  lines: z.array(diffLineSchema).readonly(),
})
export type Hunk = z.infer<typeof hunkSchema>

export const FileContentKind = { Text: "text", Binary: "binary" } as const

export const fileContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(FileContentKind.Text), hunks: z.array(hunkSchema).readonly() }),
  z.object({ kind: z.literal(FileContentKind.Binary) }),
])
export type FileContent = z.infer<typeof fileContentSchema>

export const FileChangeStatus = {
  Added: "added",
  Modified: "modified",
  Deleted: "deleted",
  Renamed: "renamed",
  Copied: "copied",
} as const
export type FileChangeStatus = (typeof FileChangeStatus)[keyof typeof FileChangeStatus]

export const SourceLanguage = { Rust: "rust", TypeScript: "typescript", Tsx: "tsx", Python: "python", Go: "go", Java: "java", C: "c", Cpp: "cpp" } as const
export type SourceLanguage = (typeof SourceLanguage)[keyof typeof SourceLanguage]

export const UnitKind = {
  Function: "function",
  Method: "method",
  Class: "class",
  Struct: "struct",
  Enum: "enum",
  Trait: "trait",
  Impl: "impl",
  Interface: "interface",
  TypeAlias: "typeAlias",
  Constant: "constant",
  Macro: "macro",
  Module: "module",
  /** A group of tests, such as `describe("parser", () => …)`. Its tests and hooks are units of their own. */
  TestSuite: "testSuite",
  /** One test, such as `it("reads includes", () => …)`. */
  Test: "test",
  /** Setup or teardown around tests, such as `beforeEach(() => …)`. */
  TestHook: "testHook",
  /** Everything in a file outside its top-level definitions: imports, top-level statements. */
  ModuleScope: "moduleScope",
} as const
export type UnitKind = (typeof UnitKind)[keyof typeof UnitKind]

/** One side of a unit: its full source text and where it sits in the file. */
export const unitSnapshotSchema = z.object({
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
  text: z.string(),
  /**
   * True when nested units are collapsed to their first line (containers and the module
   * scope), so a reviewer sees only the code the unit itself owns. Line numbers then no
   * longer follow from `startLine`.
   */
  elidesNestedUnits: z.boolean(),
})
export type UnitSnapshot = z.infer<typeof unitSnapshotSchema>

export const UnitChangeKind = {
  Added: "added",
  Removed: "removed",
  Modified: "modified",
  Renamed: "renamed",
  MovedIn: "movedIn",
  MovedOut: "movedOut",
} as const
export type UnitChangeKind = (typeof UnitChangeKind)[keyof typeof UnitChangeKind]

/**
 * How much a modification matters to a reviewer. Formatting and comment-only changes
 * leave the unit's code tokens identical, so the UI can collapse them.
 */
export const ModificationWeight = { Semantic: "semantic", CommentsOnly: "commentsOnly", FormattingOnly: "formattingOnly" } as const
export type ModificationWeight = (typeof ModificationWeight)[keyof typeof ModificationWeight]

const unitLocationSchema = z.object({ path: z.string().min(1), qualifiedName: z.string() })
export type UnitLocation = z.infer<typeof unitLocationSchema>

export const unitChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(UnitChangeKind.Added), after: unitSnapshotSchema }),
  z.object({ kind: z.literal(UnitChangeKind.Removed), before: unitSnapshotSchema }),
  z.object({
    kind: z.literal(UnitChangeKind.Modified),
    weight: z.enum(ModificationWeight),
    before: unitSnapshotSchema,
    after: unitSnapshotSchema,
  }),
  z.object({
    kind: z.literal(UnitChangeKind.Renamed),
    previousName: z.string(),
    before: unitSnapshotSchema,
    after: unitSnapshotSchema,
  }),
  /**
   * The unit arrived from another file or container; `from` says where it was. `edited` says its
   * code changed on the way, beyond formatting and comments. Older reports have no `edited`:
   * they only found unedited moves.
   */
  z.object({ kind: z.literal(UnitChangeKind.MovedIn), from: unitLocationSchema, edited: z.boolean().default(false), before: unitSnapshotSchema, after: unitSnapshotSchema }),
  /** The unit left this file or container; `to` says where it went, and `edited` matches the arriving side. */
  z.object({ kind: z.literal(UnitChangeKind.MovedOut), to: unitLocationSchema, edited: z.boolean().default(false), before: unitSnapshotSchema }),
])
export type UnitChange = z.infer<typeof unitChangeSchema>

/** What changed in a function, read from its syntax, so a reviewer knows before reading it. */
export const unitFactsSchema = z.object({
  parametersAdded: z.array(z.string()).readonly(),
  parametersRemoved: z.array(z.string()).readonly(),
  /** Parameters that kept their name but changed type or default. */
  parametersChanged: z.array(z.string()).readonly(),
  returnType: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable(),
  callsAdded: z.array(z.string()).readonly(),
  callsRemoved: z.array(z.string()).readonly(),
  /** Change in the number of places that raise, throw or bail out; negative means fewer. */
  errorPathsDelta: z.number().int(),
  /** Change in the number of conditionals and loops; negative means fewer. */
  branchesDelta: z.number().int(),
  /** Decision points in the function (cyclomatic complexity); null when unchanged. */
  complexity: z.object({ before: z.number().int(), after: z.number().int() }).nullable(),
})
export type UnitFacts = z.infer<typeof unitFactsSchema>

/** A unit and how it changed, before impact analysis. */
export const comparedUnitSchema = z.object({
  kind: z.enum(UnitKind),
  name: z.string(),
  /** Container path and name, e.g. `SizeFilter::from_str` or `Parser.parse`; unique within the file. */
  qualifiedName: z.string(),
  change: unitChangeSchema,
  /** Only for functions whose code changed; null when there is nothing to state. */
  facts: unitFactsSchema.nullable(),
})
export type ComparedUnit = z.infer<typeof comparedUnitSchema>

/**
 * How sure the engine is that a reference points at the changed unit. References are
 * found by name and syntax, not by type resolution, so another item with the same
 * name can match.
 */
export const ReferenceConfidence = {
  /** Qualified with the unit's container, e.g. `Size::new` or `Parser.parse`. */
  Exact: "exact",
  /** The unit's name used directly, where it is the only kind of thing that name can be. */
  Likely: "likely",
  /** A method call or field access by name only (`x.parse()`), whose receiver type is unknown. */
  Possible: "possible",
} as const
export type ReferenceConfidence = (typeof ReferenceConfidence)[keyof typeof ReferenceConfidence]

export const referenceSchema = z.object({
  path: z.string().min(1),
  line: lineNumberSchema,
  /** The unit containing the reference; null at module level. */
  callerQualifiedName: z.string().nullable(),
  confidence: z.enum(ReferenceConfidence),
  /** False flags code this PR did not touch but whose behaviour may change with it. */
  touchedByPullRequest: z.boolean(),
  /** The referencing line, trimmed. */
  snippet: z.string(),
})
export type Reference = z.infer<typeof referenceSchema>

export const UnitImpactStatus = { Traced: "traced", TooCommon: "tooCommon", Skipped: "skipped" } as const

/** Where the head commit still refers to a changed, removed or renamed unit. */
export const unitImpactSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal(UnitImpactStatus.Traced),
    /** The name searched for: the old name for a renamed unit. */
    searchedName: z.string(),
    references: z.array(referenceSchema).readonly(),
    /** All references found; `references` may be capped below this. */
    totalReferences: z.number().int().nonnegative(),
  }),
  /** The name appears in too many files to trace by name alone (e.g. `new`, `get`). */
  z.object({
    status: z.literal(UnitImpactStatus.TooCommon),
    searchedName: z.string(),
    matchingFiles: z.number().int().positive(),
  }),
  /** Not traced to keep the run fast on very large PRs; `reason` says why. */
  z.object({ status: z.literal(UnitImpactStatus.Skipped), searchedName: z.string(), reason: z.string() }),
])
export type UnitImpact = z.infer<typeof unitImpactSchema>

export const changedUnitSchema = comparedUnitSchema.extend({
  /** Null for changes that cannot affect callers (formatting, comments, moves, additions). */
  impact: unitImpactSchema.nullable(),
})
export type ChangedUnit = z.infer<typeof changedUnitSchema>

export const NoiseKind = { Lockfile: "lockfile", Generated: "generated", Vendored: "vendored" } as const
export type NoiseKind = (typeof NoiseKind)[keyof typeof NoiseKind]

/** Files a reviewer can skip, with the evidence for that call. */
export const fileNoiseSchema = z.object({ kind: z.enum(NoiseKind), reason: z.string() })
export type FileNoise = z.infer<typeof fileNoiseSchema>

export const SyntaxAnalysisStatus = {
  Analyzed: "analyzed",
  UnsupportedLanguage: "unsupportedLanguage",
  Skipped: "skipped",
} as const

export const outlineEntrySchema = z.object({
  kind: z.enum(UnitKind),
  qualifiedName: z.string(),
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
})
export type OutlineEntry = z.infer<typeof outlineEntrySchema>

export const unitCallSchema = z.object({ caller: z.string(), callee: z.string() })
export type UnitCall = z.infer<typeof unitCallSchema>

/** Whether the file's units could be extracted; when not, the UI falls back to hunks. */
export const syntaxAnalysisSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal(SyntaxAnalysisStatus.Analyzed),
    language: z.enum(SourceLanguage),
    /** Changed units in reading order: types, then helpers before their callers. */
    units: z.array(changedUnitSchema).readonly(),
    /** Every definition in the head version of the file, in file order. */
    outline: z.array(outlineEntrySchema).readonly(),
    /** Which changed units call which, within this file, by qualified name. */
    calls: z.array(unitCallSchema).readonly(),
  }),
  z.object({ status: z.literal(SyntaxAnalysisStatus.UnsupportedLanguage) }),
  z.object({ status: z.literal(SyntaxAnalysisStatus.Skipped), reason: z.string() }),
])
export type SyntaxAnalysis = z.infer<typeof syntaxAnalysisSchema>

const fileDiffBase = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  content: fileContentSchema,
})

const movedFileFields = {
  previousPath: z.string().min(1),
  /** Git's similarity index between the old and new file, 0–100. */
  similarity: z.number().int().min(0).max(100),
}

/** What git reports for one path: its status and hunks. */
export const fileDiffSchema = z.discriminatedUnion("status", [
  fileDiffBase.extend({ status: z.literal(FileChangeStatus.Added) }),
  fileDiffBase.extend({ status: z.literal(FileChangeStatus.Modified) }),
  fileDiffBase.extend({ status: z.literal(FileChangeStatus.Deleted) }),
  fileDiffBase.extend({ status: z.literal(FileChangeStatus.Renamed), ...movedFileFields }),
  fileDiffBase.extend({ status: z.literal(FileChangeStatus.Copied), ...movedFileFields }),
])
export type FileDiff = z.infer<typeof fileDiffSchema>

/**
 * A changed path as git sees it plus one field per analysis layer. Later milestones
 * add layers (blast radius, risk) beside these rather than widening the diff.
 */
export const changedFileSchema = z.object({
  diff: fileDiffSchema,
  noise: fileNoiseSchema.nullable(),
  syntax: syntaxAnalysisSchema,
})
export type ChangedFile = z.infer<typeof changedFileSchema>

export const RiskSeverity = { High: "high", Medium: "medium", Low: "low" } as const
export type RiskSeverity = (typeof RiskSeverity)[keyof typeof RiskSeverity]

export const RiskCategory = {
  Secret: "secret",
  DangerousApi: "dangerousApi",
  SensitivePath: "sensitivePath",
  Dependency: "dependency",
  Vulnerability: "vulnerability",
  /** Reported by a third-party code scanner such as Semgrep. */
  CodeScan: "codeScan",
  /** Poor implementation or bad practice; never counts towards the security level. */
  CodeQuality: "codeQuality",
  /** Review signals: they say where to look harder, not that something is insecure. */
  Tests: "tests",
  Size: "size",
  BrokenReference: "brokenReference",
  /** Could break other code or a deployment: a public API, a migration or a config key. */
  BreakingChange: "breakingChange",
  /** A new dependency's licence isn't on the team's allowlist; a policy question, not a security one. */
  License: "license",
} as const
export type RiskCategory = (typeof RiskCategory)[keyof typeof RiskCategory]

export const riskLocationSchema = z.object({ path: z.string().min(1), line: lineNumberSchema.nullable() })
export type RiskLocation = z.infer<typeof riskLocationSchema>

/** One reason to look harder at the change, with the evidence that triggered it. */
export const riskSchema = z.object({
  /** Stable identifier of the rule, e.g. `python.subprocess-shell`. */
  ruleId: z.string(),
  category: z.enum(RiskCategory),
  severity: z.enum(RiskSeverity),
  title: z.string(),
  /** Why this matters and what to check. */
  detail: z.string(),
  /** Null for findings about the PR as a whole, such as its size. */
  location: riskLocationSchema.nullable(),
  /** The triggering line, with any secret redacted. */
  evidence: z.string().nullable(),
  /** The changed unit this is about, for when no line can say: a removed function has none at head. */
  unit: z.string().optional(),
})
export type Risk = z.infer<typeof riskSchema>

/** A check that did not run, so a low level is never read as "everything was checked". */
export const skippedCheckSchema = z.object({ check: z.string(), reason: z.string() })
export type SkippedCheck = z.infer<typeof skippedCheckSchema>

/** A check that did run, so "not checked" has its counterpart. */
export const checkRunSchema = z.object({ name: z.string(), detail: z.string() })
export type CheckRun = z.infer<typeof checkRunSchema>

export const riskAssessmentSchema = z.object({
  /**
   * The highest severity among security findings (secrets, dangerous APIs, sensitive paths,
   * dependencies, vulnerabilities). Deliberately never "safe": low means nothing was found
   * by the checks that ran.
   */
  securityLevel: z.enum(RiskSeverity),
  /** All findings, security and review signals, most severe first. */
  findings: z.array(riskSchema).readonly(),
  checksRun: z.array(checkRunSchema).readonly(),
  notChecked: z.array(skippedCheckSchema).readonly(),
})
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>

export const CitationSide = { Before: "before", After: "after" } as const
export type CitationSide = (typeof CitationSide)[keyof typeof CitationSide]

/** A line range of the change that backs an AI statement; validated against the diff. */
export const citationSchema = z.object({
  path: z.string().min(1),
  /** Which version the lines refer to: the merge base or the head. */
  side: z.enum(CitationSide),
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
})
export type Citation = z.infer<typeof citationSchema>

export const unitRefSchema = z.object({ path: z.string().min(1), qualifiedName: z.string() })
export type UnitRef = z.infer<typeof unitRefSchema>

/** A step of the suggested reading order: related units, read together. */
export const chapterSchema = z.object({
  title: z.string(),
  summary: z.string(),
  units: z.array(unitRefSchema).readonly(),
})
export type Chapter = z.infer<typeof chapterSchema>

export const IntentVerdict = {
  /** The code does what the description says. */
  Matches: "matches",
  /** The code does something different from what the description says. */
  Contradicts: "contradicts",
  /** The code changes behaviour the description does not mention. */
  Undocumented: "undocumented",
  /** The description claims something no changed code shows; the only verdict without citations. */
  NotFound: "notFound",
} as const
export type IntentVerdict = (typeof IntentVerdict)[keyof typeof IntentVerdict]

export const intentFindingSchema = z.object({
  /** What the PR description says, or for undocumented changes, what the code does. */
  claim: z.string(),
  verdict: z.enum(IntentVerdict),
  explanation: z.string(),
  citations: z.array(citationSchema).readonly(),
})
export type IntentFinding = z.infer<typeof intentFindingSchema>

/** A question the reviewer should be able to answer before approving. */
export const reviewerQuestionSchema = z.object({
  question: z.string(),
  why: z.string(),
  citations: z.array(citationSchema).min(1).readonly(),
})
export type ReviewerQuestion = z.infer<typeof reviewerQuestionSchema>

export const AiReviewStatus = { Disabled: "disabled", Unavailable: "unavailable", Completed: "completed" } as const

export const aiReviewSchema = z.discriminatedUnion("status", [
  /** AI review is opt-in and was not requested. */
  z.object({ status: z.literal(AiReviewStatus.Disabled) }),
  /** Requested but not run: blocked by the repository's config, no credentials, or a failed call. */
  z.object({ status: z.literal(AiReviewStatus.Unavailable), reason: z.string() }),
  z.object({
    status: z.literal(AiReviewStatus.Completed),
    model: z.string(),
    chapters: z.array(chapterSchema).readonly(),
    intent: z.array(intentFindingSchema).readonly(),
    questions: z.array(reviewerQuestionSchema).readonly(),
    /** Statements the model made whose citations did not match the change; never shown. */
    droppedStatements: z.number().int().nonnegative(),
    /** Changed units left out of the prompt to stay within the input budget (named only). */
    unitsSummarizedOnly: z.number().int().nonnegative(),
    usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
    /** Null when the model's price is not known to this version. */
    estimatedCostUsd: z.number().nonnegative().nullable(),
    /** True when the result came from the local cache for this exact prompt. */
    cached: z.boolean(),
  }),
])
export type AiReview = z.infer<typeof aiReviewSchema>

/**
 * Which lines the PR added ran in tests. Lines that can't run, such as comments, are in neither
 * list. A report from CI or from the PR is produced by the PR's own code, so it can show that
 * code ran, but is not proof against someone trying to deceive.
 */
export const testCoverageSchema = z.object({
  /** Where the report came from, in words, so a reader can judge it. */
  source: z.string(),
  files: z
    .array(z.object({ path: z.string().min(1), coveredLines: z.array(lineNumberSchema).readonly(), uncoveredLines: z.array(lineNumberSchema).readonly() }))
    .readonly(),
})
export type TestCoverage = z.infer<typeof testCoverageSchema>

export const reviewModelSchema = z.object({
  schemaVersion: z.literal(REVIEW_MODEL_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  pullRequest: pullRequestSchema,
  files: z.array(changedFileSchema).readonly(),
  risk: riskAssessmentSchema,
  ai: aiReviewSchema,
  /** Null when no coverage report was supplied. */
  testCoverage: testCoverageSchema.nullable().default(null),
  /** Where to send feedback on the tool, from the repository's config. */
  feedbackUrl: z.url({ protocol: /^https?$/ }).nullable(),
})
export type ReviewModel = z.infer<typeof reviewModelSchema>

/** A review of a pull request on its host, the only kind with somewhere to post comments or a review. */
export type HostedReviewModel = ReviewModel & { readonly pullRequest: HostedPullRequest }

export function isHostedReview(model: ReviewModel): model is HostedReviewModel {
  return isHostedPullRequest(model.pullRequest)
}

export const ReviewStatus = { Queued: "queued", Analyzing: "analyzing", Ready: "ready", Failed: "failed" } as const
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus]

/** Coverage reports a reviewer picked for one PR, as text from their browser. */
export const attachCoverageRequestSchema = z.object({
  reports: z.array(z.object({ name: z.string().min(1), text: z.string() })).min(1),
})
export type AttachCoverageRequest = z.infer<typeof attachCoverageRequestSchema>

/** What a report describes: the commit it was made from, and the branch that commit was compared with. */
export const reportHeadSchema = z.object({ headSha: commitShaSchema, baseRef: z.string() })
export type ReportHead = z.infer<typeof reportHeadSchema>

/** One row of the local app's review list; the JSON its API and page share. */
export const reviewSummarySchema = z.object({
  id: z.number().int().positive(),
  url: z.url(),
  host: z.enum(GitHostKind),
  /** `owner/repo#12` or `group/project!12`, known before the analysis finishes. */
  displayName: z.string(),
  number: z.number().int().positive(),
  status: z.enum(ReviewStatus),
  /** The step a running analysis is on; null unless analyzing. Kept in memory, not stored. */
  step: z.enum(AnalysisStep).nullable().default(null),
  /** Why the last analysis failed; null otherwise. */
  error: z.string().nullable(),
  /** False until an analysis succeeds; a failed refresh keeps the earlier report. */
  hasReport: z.boolean(),
  ai: z.boolean(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  securityLevel: z.enum(RiskSeverity).nullable(),
  unitsToReview: z.number().int().nonnegative().nullable(),
  untouchedReferences: z.number().int().nonnegative().nullable(),
  findings: z.number().int().nonnegative().nullable(),
  /** Where the report's test coverage came from; null when none was found. */
  coverageSource: z.string().nullable(),
  /** Null until an analysis succeeds. */
  reportHead: reportHeadSchema.nullable(),
  /** Null unless the reviewer grouped this review with others in its stack. */
  stack: stackPlaceSchema.nullable(),
  /** A stack found for it that the reviewer can accept; null when there's nothing new to offer. */
  stackOffer: stackOfferSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ReviewSummary = z.infer<typeof reviewSummarySchema>

/** The request body for adding a review to the local app. */
export const addReviewRequestSchema = z.object({ url: z.string().min(1), ai: z.boolean() })
export type AddReviewRequest = z.infer<typeof addReviewRequestSchema>
