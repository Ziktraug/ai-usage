import { DELEGATION_JOB_BOUNDS } from '@ai-usage/report-core/delegation-job';
import { DELEGATION_CONFIG_BOUNDS, DELEGATION_RULE_ID_PATTERN } from '@ai-usage/report-core/delegation-policy';
import { DELEGATION_QUALIFICATION_BOUNDS } from '@ai-usage/report-core/delegation-qualification';
import { DELEGATION_RESULT_BOUNDS } from '@ai-usage/report-core/delegation-result';
import {
  DELEGATION_ABSTENTION_REASONS,
  DELEGATION_ACCEPTANCE_VERDICTS,
  DELEGATION_BOUNDS,
  DELEGATION_CANCEL_RESULTS,
  DELEGATION_CATALOGED_HARNESSES,
  DELEGATION_CONTEXTS,
  DELEGATION_EVALUATION_AUTHORS,
  DELEGATION_EVALUATION_KINDS,
  DELEGATION_EXECUTOR_HARNESSES,
  DELEGATION_FINDING_SEVERITIES,
  DELEGATION_IDENTITY_EVIDENCE,
  DELEGATION_JOB_STATES,
  DELEGATION_PROVIDERS,
  DELEGATION_QUALIFICATION_OUTCOMES,
  DELEGATION_QUALIFICATION_PURPOSES,
  DELEGATION_REFUSAL_REASONS,
  DELEGATION_RELEASE_EVIDENCE,
  DELEGATION_RESULT_KINDS,
  DELEGATION_REVISION_PATTERN,
  DELEGATION_ROUTE_BLOCKERS,
  DELEGATION_RULE_EFFECTS,
  DELEGATION_SCOPE_KINDS,
  DELEGATION_TASK_CATEGORIES,
  DELEGATION_VERIFICATION_VERDICTS,
} from '@ai-usage/report-core/delegation-vocabulary';
import { REVIEW_ATTEMPT_BOUNDS } from '@ai-usage/report-core/work-attempts';
import { EXECUTOR_BOUNDS } from '@ai-usage/report-core/work-executors';
import { CANDIDATE_IDENTITY_STATES } from '@ai-usage/report-core/work-routing-vocabulary';
import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  type BaseIssue,
  type BaseSchema,
  boolean,
  check,
  custom,
  type InferOutput,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  optional,
  parse,
  picklist,
  pipe,
  record,
  regex,
  safeInteger,
  strictObject,
  string,
  variant,
} from 'valibot';
import { publicErrorMap } from './errors';
import {
  emptyInputSchema,
  isJsonWireValue,
  type JsonWireValue,
  jsonWireValueSchema,
  publicReasonSchema,
} from './schema-conventions';
import { executorDeclarationSchema } from './work-routing';

/**
 * Delegation (ADR 0077): the Web edge of the bounded read-only reviews a calling MCP client hands
 * to AI Usage. The Web never starts a delegation; it reads the policy and the jobs, writes the
 * policy through the engine, simulates a qualification, cancels a live job and records the
 * operator's acceptance. Every shape here mirrors a report-core type (`delegation-contracts.ts`,
 * `delegation-job.ts`) with the same bounds, so a view the store or the engine produced validates
 * here unchanged and anything else is refused at the boundary.
 *
 * The bounds are imported from the report-core modules that own them rather than restated; only
 * the constants are reached for, the parsers behind them stay out of the browser closure.
 */

// ---------------------------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------------------------

export const DELEGATION_WEB_BOUNDS = {
  /** Jobs the Work view asks for by default. */
  defaultListLimit: 20,
  /** Config issues one answer lists (read, or an `invalid` write). */
  maxIssues: 256,
  /** Serialized bytes of one `jobs` answer; the server drops trailing jobs beyond it and counts them in `omitted`. */
  maxJobsListBytes: 512 * 1024,
  /** Jobs one list read returns at most. */
  maxListLimit: 50,
  /** Notes the job view carries (two fixed sentences plus one per situation). */
  maxNotes: 8,
  maxNoteCharacters: 512,
  /** Serialized bytes of one `saveSettings` input: under the engine's command bound with room for the envelope. */
  maxSaveInputBytes: 48 * 1024,
  /** A policy or catalog revision (16 hexadecimal characters today; the bound leaves room for a later format). */
  maxRevisionCharacters: 64,
  /** A refusal or failure message relayed from the engine. */
  maxMessageCharacters: 2000,
} as const;

const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const serializedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const timestampSchema = custom<string>(isStrictIsoTimestamp, 'Expected a canonical ISO timestamp.');
const countSchema = pipe(number(), safeInteger(), minValue(0));
const positiveCountSchema = pipe(number(), safeInteger(), minValue(1));
const percentSchema = pipe(number(), minValue(0), maxValue(100));
/** Lowercase RFC 4122 text, the form `crypto.randomUUID()` produces. */
const uuidSchema = pipe(
  string(),
  regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'Expected a lowercase UUID.'),
);
const idSchema = pipe(string(), minLength(1), maxLength(DELEGATION_JOB_BOUNDS.maxIdCharacters));
const textSchema = pipe(string(), minLength(1), maxLength(DELEGATION_JOB_BOUNDS.maxTextCharacters));
const configTextSchema = pipe(string(), minLength(1), maxLength(DELEGATION_CONFIG_BOUNDS.maxText));
const configLongTextSchema = pipe(string(), minLength(1), maxLength(DELEGATION_CONFIG_BOUNDS.maxLongText));
const pathSchema = pipe(string(), minLength(1), maxLength(DELEGATION_BOUNDS.maxCheckoutPathCharacters));
const absolutePathSchema = pipe(pathSchema, regex(/^\//u, 'Expected an absolute path.'));
const revisionSchema = pipe(string(), minLength(1), maxLength(DELEGATION_WEB_BOUNDS.maxRevisionCharacters));
const messageSchema = pipe(string(), minLength(1), maxLength(DELEGATION_WEB_BOUNDS.maxMessageCharacters));
const objectIdSchema = pipe(string(), regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 'Expected a git object id.'));
const sha256Schema = pipe(string(), regex(/^[0-9a-f]{64}$/u, 'Expected a SHA-256 digest.'));
/** A Git revision the engine resolves itself; never an option. */
const gitRevisionSchema = pipe(
  string(),
  regex(DELEGATION_REVISION_PATTERN, 'Expected a git revision.'),
  check((value) => !value.startsWith('-'), 'A revision must not start with a dash.'),
);
const qualificationTextSchema = pipe(string(), minLength(1), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxText));
const qualificationListSchema = pipe(
  array(qualificationTextSchema),
  maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxEntries),
);
const lineList = (maxEntries: number, maxCharacters: number) =>
  pipe(array(pipe(string(), minLength(1), maxLength(maxCharacters))), maxLength(maxEntries));
const rangeSchema = (bounds: { readonly max: number; readonly min: number }) =>
  pipe(number(), safeInteger(), minValue(bounds.min), maxValue(bounds.max));

const executorHarnessSchema = picklist(DELEGATION_EXECUTOR_HARNESSES);
const providerSchema = picklist(DELEGATION_PROVIDERS);
const contextSchema = picklist(DELEGATION_CONTEXTS);
const identityEvidenceSchema = picklist(DELEGATION_IDENTITY_EVIDENCE);
const taskCategorySchema = picklist(DELEGATION_TASK_CATEGORIES);
const provenanceSchema = picklist(['observed-now', 'stale', 'unknown']);

/** A config path and a reason, never the offending value. */
export const delegationIssueSchema = strictObject({
  path: pipe(string(), minLength(1), maxLength(512)),
  reason: pipe(string(), minLength(1), maxLength(512)),
});
const issuesSchema = pipe(array(delegationIssueSchema), maxLength(DELEGATION_WEB_BOUNDS.maxIssues));

export const delegationScopeRequestSchema = variant('kind', [
  strictObject({ commit: gitRevisionSchema, kind: literal('commit') }),
  strictObject({ base: gitRevisionSchema, head: gitRevisionSchema, kind: literal('range') }),
]);

// ---------------------------------------------------------------------------------------------
// Configuration (the parsed home `delegation` section, as `parseDelegationConfig` produces it)
// ---------------------------------------------------------------------------------------------

const configRange = DELEGATION_CONFIG_BOUNDS.range;

export const delegationDefaultsSchema = strictObject({
  identityEvidence: identityEvidenceSchema,
  maxAttempts: rangeSchema(configRange.maxAttempts),
  maxConcurrentPerPool: rangeSchema(configRange.maxConcurrent),
  qualificationTtlSeconds: rangeSchema(configRange.qualificationTtlSeconds),
  reservePercent: rangeSchema(configRange.reservePercent),
});

export const delegationRouteAnnotationSchema = strictObject({
  accountScope: configTextSchema,
  context: contextSchema,
  harness: executorHarnessSchema,
  label: optional(configTextSchema),
  machineId: optional(configTextSchema),
  maxConcurrent: optional(rangeSchema(configRange.maxConcurrent)),
  reservePercent: optional(rangeSchema(configRange.reservePercent)),
});

export const delegationRuleSchema = strictObject({
  description: optional(configLongTextSchema),
  effect: picklist(DELEGATION_RULE_EFFECTS),
  id: pipe(string(), regex(DELEGATION_RULE_ID_PATTERN, 'Expected a rule id.')),
  match: strictObject({
    checkoutPath: optional(absolutePathSchema),
    gitAuthorEmail: optional(configTextSchema),
    githubAccount: optional(configTextSchema),
    githubOwner: optional(configTextSchema),
    repository: optional(configTextSchema),
  }),
  require: optional(
    strictObject({
      identityEvidence: optional(identityEvidenceSchema),
      maxAttempts: optional(rangeSchema(configRange.maxAttempts)),
      maxConcurrent: optional(rangeSchema(configRange.maxConcurrent)),
      reservePercent: optional(rangeSchema(configRange.reservePercent)),
    }),
  ),
  routes: optional(
    strictObject({
      accountScopes: optional(pipe(array(configTextSchema), maxLength(DELEGATION_CONFIG_BOUNDS.maxListEntries))),
      contexts: optional(pipe(array(contextSchema), maxLength(DELEGATION_CONTEXTS.length))),
      harnesses: optional(pipe(array(executorHarnessSchema), maxLength(DELEGATION_EXECUTOR_HARNESSES.length))),
      providers: optional(pipe(array(providerSchema), maxLength(DELEGATION_PROVIDERS.length))),
    }),
  ),
});

export const delegationPreferencesSchema = strictObject({
  harnesses: pipe(array(executorHarnessSchema), maxLength(DELEGATION_EXECUTOR_HARNESSES.length)),
  models: pipe(array(configTextSchema), maxLength(DELEGATION_CONFIG_BOUNDS.maxListEntries)),
  nearResetMinutes: nullable(pipe(number(), minValue(0), maxValue(DELEGATION_CONFIG_BOUNDS.maxNearResetMinutes))),
});

/** An operator's declaration about a model; never a measured performance. */
export const delegationModelEntrySchema = strictObject({
  alias: nullable(configTextSchema),
  declaredAt: timestampSchema,
  discouragedFor: pipe(array(taskCategorySchema), maxLength(DELEGATION_TASK_CATEGORIES.length)),
  harnesses: pipe(array(executorHarnessSchema), maxLength(DELEGATION_EXECUTOR_HARNESSES.length)),
  id: configTextSchema,
  nativeId: configTextSchema,
  note: nullable(configLongTextSchema),
  provider: providerSchema,
  recommendedFor: pipe(array(taskCategorySchema), maxLength(DELEGATION_TASK_CATEGORIES.length)),
  resolvedVersion: nullable(configTextSchema),
});

export const delegationConfigSchema = strictObject({
  defaults: delegationDefaultsSchema,
  models: pipe(array(delegationModelEntrySchema), maxLength(DELEGATION_CONFIG_BOUNDS.maxModels)),
  preferences: delegationPreferencesSchema,
  routes: pipe(array(delegationRouteAnnotationSchema), maxLength(DELEGATION_CONFIG_BOUNDS.maxRoutes)),
  rules: pipe(array(delegationRuleSchema), maxLength(DELEGATION_CONFIG_BOUNDS.maxRules)),
});

// ---------------------------------------------------------------------------------------------
// Settings view (delegation.settings)
// ---------------------------------------------------------------------------------------------

/**
 * One declared executor × model as the policy sees it now: computed server-side with
 * `qualifyReviewCandidates` (no target) and annotated by `delegation.routes[]`. Nothing here is a
 * decision for a task; it is the standing of the route and what is missing to decide.
 */
export const delegationRouteStatusSchema = strictObject({
  accountScope: textSchema,
  availability: strictObject({
    authMethod: nullable(pipe(string(), minLength(1), maxLength(EXECUTOR_BOUNDS.maxAuthMethod))),
    authState: nullable(picklist(['logged-in', 'logged-out', 'unknown'])),
    observedAt: nullable(timestampSchema),
    provenance: provenanceSchema,
    state: picklist(['available', 'unavailable', 'unknown']),
    version: nullable(textSchema),
  }),
  context: nullable(contextSchema),
  effort: nullable(textSchema),
  harness: executorHarnessSchema,
  identity: strictObject({
    declared: nullable(textSchema),
    observed: nullable(textSchema),
    observedAt: nullable(timestampSchema),
    state: picklist(CANDIDATE_IDENTITY_STATES),
  }),
  label: textSchema,
  /** Latest executor observation time for this route's harness; `null` when never observed. */
  lastCheckedAt: nullable(timestampSchema),
  /** The candidate's qualification actions: precise steps that would supply what is missing. */
  missing: qualificationListSchema,
  model: nullable(textSchema),
  poolId: idSchema,
  provider: providerSchema,
  quota: strictObject({
    observedAt: nullable(timestampSchema),
    provenance: provenanceSchema,
    windows: pipe(
      array(
        strictObject({
          label: qualificationTextSchema,
          remainingPercent: nullable(percentSchema),
          resetsAt: nullable(timestampSchema),
          scope: picklist(['account', 'model', 'unknown']),
        }),
      ),
      maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxEntries),
    ),
  }),
  routeId: idSchema,
  /** Declared, or `api` when an observed API-key sign-in contradicts the declaration. */
  subscription: picklist(['verified', 'api', 'unverified']),
});

export const delegationHarnessSupportSchema = strictObject({
  /** Any MCP client can describe and follow a delegation; the caller is never the executor. */
  caller: textSchema,
  executor: picklist(['supported', 'not-supported']),
  harness: picklist(DELEGATION_CATALOGED_HARNESSES),
  reason: pipe(string(), minLength(1), maxLength(DELEGATION_WEB_BOUNDS.maxNoteCharacters)),
});

const observedModelSchema = strictObject({
  jobs: positiveCountSchema,
  lastSeenAt: timestampSchema,
  modelResolved: textSchema,
});

export const delegationSettingsViewSchema = strictObject({
  catalogRevision: revisionSchema,
  /** The home config path, so the operator knows which file the engine writes; never its content. */
  configPath: pathSchema,
  delegation: strictObject({ config: delegationConfigSchema, issues: issuesSchema }),
  executors: strictObject({
    declarations: pipe(array(executorDeclarationSchema), maxLength(EXECUTOR_BOUNDS.maxDeclarations)),
    issues: issuesSchema,
  }),
  githubAccounts: pipe(
    array(strictObject({ ghUser: configTextSchema, owner: configTextSchema })),
    maxLength(DELEGATION_CONFIG_BOUNDS.maxListEntries),
  ),
  harnesses: pipe(array(delegationHarnessSupportSchema), maxLength(DELEGATION_CATALOGED_HARNESSES.length)),
  machineId: nullable(textSchema),
  /** The declared catalog beside what jobs reported for each entry; `null` when no job ran it. */
  models: pipe(
    array(strictObject({ entry: delegationModelEntrySchema, observed: nullable(observedModelSchema) })),
    maxLength(DELEGATION_CONFIG_BOUNDS.maxModels),
  ),
  /** Models jobs requested and what the harness reported running, counted; deterministic order, never a ranking. */
  observedModels: pipe(
    array(
      strictObject({
        harness: executorHarnessSchema,
        jobs: positiveCountSchema,
        lastSeenAt: timestampSchema,
        modelRequested: textSchema,
        modelResolved: nullable(textSchema),
      }),
    ),
    maxLength(DELEGATION_WEB_BOUNDS.maxListLimit),
  ),
  reviewTargets: strictObject({
    issues: issuesSchema,
    targets: pipe(
      array(strictObject({ checkoutPath: pathSchema, label: nullable(textSchema) })),
      maxLength(REVIEW_ATTEMPT_BOUNDS.maxReviewTargets),
    ),
  }),
  /** The policy revision; `expectedRevision` of the next save. */
  revision: revisionSchema,
  routes: pipe(array(delegationRouteStatusSchema), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxRoutes)),
});

// ---------------------------------------------------------------------------------------------
// Qualification (delegation.simulate)
// ---------------------------------------------------------------------------------------------

/** A scalar fact is declared, observed or unknown; only a list fact can be `partial` (the identified part of a longer list). */
const SCALAR_FACT_PROVENANCES = ['declared', 'observed', 'unknown'] as const;
const LIST_FACT_PROVENANCES = ['declared', 'observed', 'partial', 'unknown'] as const;

const factSchema = <Value extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  value: Value,
  provenances: typeof LIST_FACT_PROVENANCES | typeof SCALAR_FACT_PROVENANCES,
) =>
  strictObject({
    provenance: picklist(provenances),
    source: qualificationTextSchema,
    value: nullable(value),
  });

export const delegationFrozenScopeSchema = strictObject({
  base: picklist(['empty-tree', 'first-parent', 'range-base']),
  baseRef: nullable(gitRevisionSchema),
  baseSha: objectIdSchema,
  commitCount: countSchema,
  headRef: gitRevisionSchema,
  headSha: objectIdSchema,
  kind: picklist(DELEGATION_SCOPE_KINDS),
});

export const delegationRouteRequirementsSchema = strictObject({
  identityEvidence: identityEvidenceSchema,
  maxAttempts: rangeSchema(configRange.maxAttempts),
  maxConcurrent: rangeSchema(configRange.maxConcurrent),
  reservePercent: rangeSchema(configRange.reservePercent),
});

export const delegationQualifiedRouteSchema = strictObject({
  accountScope: nullable(textSchema),
  admissible: boolean(),
  advantages: qualificationListSchema,
  blockers: pipe(array(picklist(DELEGATION_ROUTE_BLOCKERS)), maxLength(DELEGATION_ROUTE_BLOCKERS.length)),
  context: nullable(contextSchema),
  effort: nullable(textSchema),
  exclusions: qualificationListSchema,
  harness: executorHarnessSchema,
  identity: nullable(
    strictObject({ declared: nullable(textSchema), observed: nullable(textSchema), state: qualificationTextSchema }),
  ),
  label: qualificationTextSchema,
  limits: qualificationListSchema,
  liveJobsInPool: countSchema,
  missing: qualificationListSchema,
  model: nullable(textSchema),
  /** Deterministic tie-break among admissible routes; `null` when excluded; never a judgment of the task. */
  orderHint: nullable(countSchema),
  poolId: idSchema,
  provider: providerSchema,
  quota: pipe(
    array(
      strictObject({
        label: qualificationTextSchema,
        observedAt: nullable(timestampSchema),
        remainingPercent: nullable(percentSchema),
        resetsAt: nullable(timestampSchema),
        scope: picklist(['account', 'model', 'unknown']),
      }),
    ),
    maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxEntries),
  ),
  requirements: delegationRouteRequirementsSchema,
  routeId: idSchema,
});

export const delegationQualificationSchema = pipe(
  strictObject({
    admissibleRouteIds: pipe(array(idSchema), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxRoutes)),
    appliedRules: pipe(
      array(
        strictObject({
          applies: picklist(['assumed', 'yes']),
          effect: picklist(DELEGATION_RULE_EFFECTS),
          id: pipe(string(), regex(DELEGATION_RULE_ID_PATTERN, 'Expected a rule id.')),
          reason: qualificationTextSchema,
        }),
      ),
      maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxAppliedRules),
    ),
    assumptions: pipe(array(qualificationTextSchema), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxAssumptions)),
    checkout: nullable(
      strictObject({ admittedBy: nullable(pathSchema), path: absolutePathSchema, projectLabel: textSchema }),
    ),
    checkoutFacts: nullable(
      strictObject({
        gitAuthorEmail: factSchema(textSchema, SCALAR_FACT_PROVENANCES),
        githubAccount: factSchema(textSchema, SCALAR_FACT_PROVENANCES),
        githubOwners: factSchema(
          pipe(array(textSchema), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxEntries)),
          LIST_FACT_PROVENANCES,
        ),
        repositories: factSchema(
          pipe(array(textSchema), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxEntries)),
          LIST_FACT_PROVENANCES,
        ),
      }),
    ),
    omittedRoutes: countSchema,
    outcome: picklist(DELEGATION_QUALIFICATION_OUTCOMES),
    purpose: picklist(DELEGATION_QUALIFICATION_PURPOSES),
    qualificationId: uuidSchema,
    qualifiedAt: timestampSchema,
    refusal: nullable(strictObject({ message: messageSchema, reason: picklist(DELEGATION_REFUSAL_REASONS) })),
    request: strictObject({ action: textSchema, digest: sha256Schema, taskCategory: textSchema }),
    routes: pipe(array(delegationQualifiedRouteSchema), maxLength(DELEGATION_QUALIFICATION_BOUNDS.maxRoutes)),
    schemaVersion: literal(1),
    scope: nullable(delegationFrozenScopeSchema),
    validUntil: timestampSchema,
    versions: strictObject({
      catalogRevision: revisionSchema,
      policyRevision: revisionSchema,
      qualifier: textSchema,
      selectorContract: textSchema,
    }),
  }),
  check(
    (value) => serializedBytes(value) <= DELEGATION_QUALIFICATION_BOUNDS.maxBytes,
    'The qualification exceeds its byte bound.',
  ),
);

// ---------------------------------------------------------------------------------------------
// Job view (delegation.jobs, delegation.job): the report-core `DelegationJobView`, field for field
// ---------------------------------------------------------------------------------------------

export const delegationEvaluationViewSchema = strictObject({
  author: picklist(DELEGATION_EVALUATION_AUTHORS),
  authorLabel: nullable(textSchema),
  checks: lineList(DELEGATION_BOUNDS.maxEvaluationChecks, DELEGATION_BOUNDS.maxEvaluationCheckCharacters),
  evaluationId: idSchema,
  kind: picklist(DELEGATION_EVALUATION_KINDS),
  note: nullable(pipe(string(), maxLength(DELEGATION_BOUNDS.maxEvaluationNoteCharacters))),
  recordedAt: timestampSchema,
  verdict: picklist([...DELEGATION_ACCEPTANCE_VERDICTS, ...DELEGATION_VERIFICATION_VERDICTS]),
});
const evaluationsSchema = pipe(
  array(delegationEvaluationViewSchema),
  maxLength(DELEGATION_JOB_BOUNDS.maxEvaluationsInView),
);

export const delegationExecutedScopeSchema = strictObject({
  fileCount: countSchema,
  files: pipe(
    array(
      strictObject({
        coverage: picklist(['binary', 'complete', 'omitted', 'partial']),
        path: pipe(string(), minLength(1), maxLength(DELEGATION_JOB_BOUNDS.maxScopePathCharacters)),
      }),
    ),
    maxLength(DELEGATION_JOB_BOUNDS.maxScopeFiles),
  ),
  includedBytes: countSchema,
  patchBytes: countSchema,
  patchSha256: sha256Schema,
  truncated: boolean(),
  workingTreeDirty: boolean(),
});

/** What the harness was allowed to do, as launched; "read-only" rests on these controls. */
export const delegationGuaranteeSchema = strictObject({
  cliVersion: textSchema,
  controls: lineList(DELEGATION_JOB_BOUNDS.maxGuaranteeEntries, DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters),
  effort: nullable(textSchema),
  harness: executorHarnessSchema,
  limits: lineList(DELEGATION_JOB_BOUNDS.maxGuaranteeEntries, DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters),
  model: nullable(textSchema),
});

/** Tokens as the harness reported them; never converted to a budget. */
export const delegationUsageSchema = strictObject({
  cachedInputTokens: nullable(countSchema),
  inputTokens: nullable(countSchema),
  outputTokens: nullable(countSchema),
  source: literal('harness-reported'),
});

export const delegationFindingSchema = strictObject({
  detail: pipe(string(), minLength(1), maxLength(DELEGATION_RESULT_BOUNDS.maxDetailCharacters)),
  evidence: pipe(
    array(
      strictObject({
        line: nullable(positiveCountSchema),
        path: pipe(string(), minLength(1), maxLength(DELEGATION_RESULT_BOUNDS.maxPathCharacters)),
      }),
    ),
    maxLength(DELEGATION_RESULT_BOUNDS.maxEvidencePerFinding),
  ),
  severity: picklist(DELEGATION_FINDING_SEVERITIES),
  title: pipe(string(), minLength(1), maxLength(DELEGATION_RESULT_BOUNDS.maxTitleCharacters)),
});

export const delegationResultViewSchema = strictObject({
  checks: lineList(DELEGATION_RESULT_BOUNDS.maxChecks, DELEGATION_RESULT_BOUNDS.maxCheckCharacters),
  coverage: nullable(
    strictObject({
      notReviewed: lineList(
        DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewed,
        DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewedCharacters,
      ),
      reviewed: pipe(string(), minLength(1), maxLength(DELEGATION_RESULT_BOUNDS.maxCoverageReviewedCharacters)),
    }),
  ),
  /** The worker's final text when it did not satisfy the contract, bounded; else `null`. */
  excerpt: nullable(pipe(string(), minLength(1), maxLength(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters))),
  findings: pipe(array(delegationFindingSchema), maxLength(DELEGATION_RESULT_BOUNDS.maxFindings)),
  kind: picklist(DELEGATION_RESULT_KINDS),
  limits: lineList(DELEGATION_RESULT_BOUNDS.maxLimits, DELEGATION_RESULT_BOUNDS.maxLimitCharacters),
  summary: nullable(pipe(string(), minLength(1), maxLength(DELEGATION_RESULT_BOUNDS.maxSummaryCharacters))),
});

const selectorVersionSchema = pipe(string(), minLength(1), maxLength(DELEGATION_BOUNDS.maxSelectorVersionCharacters));

/** The selector's statement: a choice with its stated rationale and confidence, or an abstention. */
export const delegationSelectionSchema = variant('kind', [
  strictObject({
    /** Self-reported by the selector; never a measured probability that the task succeeds. */
    confidence: optional(pipe(number(), minValue(0), maxValue(1))),
    kind: literal('choice'),
    qualificationId: uuidSchema,
    rationale: optional(
      lineList(DELEGATION_BOUNDS.maxSelectionRationale, DELEGATION_BOUNDS.maxSelectionRationaleCharacters),
    ),
    routeId: idSchema,
    selectorVersion: selectorVersionSchema,
  }),
  strictObject({
    kind: literal('abstain'),
    note: optional(pipe(string(), minLength(1), maxLength(DELEGATION_JOB_BOUNDS.maxSelectionNoteCharacters))),
    qualificationId: uuidSchema,
    reason: picklist(DELEGATION_ABSTENTION_REASONS),
    selectorVersion: selectorVersionSchema,
  }),
]);

export const delegationExecutionStatuses = [
  'cancelled',
  'failed',
  'not-run',
  'running',
  'succeeded',
  'unknown',
] as const;

export const delegationJobViewSchema = pipe(
  strictObject({
    attemptNumber: positiveCountSchema,
    cancelRequestedAt: nullable(timestampSchema),
    endedAt: nullable(timestampSchema),
    evaluations: strictObject({
      /** The latest acceptance recorded by the operator; a model's acceptance is its statement, listed below. */
      acceptance: nullable(delegationEvaluationViewSchema),
      acceptances: evaluationsSchema,
      automatedChecks: evaluationsSchema,
      verifications: evaluationsSchema,
    }),
    executedScope: nullable(delegationExecutedScopeSchema),
    /** The failure recorded on a job that was not refused; a refusal's message is under `refusal`. */
    failure: nullable(pipe(string(), maxLength(DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters))),
    /** The scope the engine froze when it admitted the job, as recorded; `null` when none was. Never re-resolved. */
    frozenScope: nullable(delegationFrozenScopeSchema),
    guarantee: nullable(delegationGuaranteeSchema),
    heartbeatAgeSeconds: nullable(countSchema),
    jobId: uuidSchema,
    live: boolean(),
    machineId: textSchema,
    notes: lineList(DELEGATION_WEB_BOUNDS.maxNotes, DELEGATION_WEB_BOUNDS.maxNoteCharacters),
    qualification: nullable(
      strictObject({
        admissibleRoutes: countSchema,
        catalogRevision: nullable(revisionSchema),
        excludedRoutes: pipe(
          array(
            strictObject({
              blockers: pipe(array(picklist(DELEGATION_ROUTE_BLOCKERS)), maxLength(DELEGATION_ROUTE_BLOCKERS.length)),
              routeId: idSchema,
            }),
          ),
          maxLength(DELEGATION_JOB_BOUNDS.maxExcludedRoutesInView),
        ),
        omittedExcludedRoutes: countSchema,
        policyRevision: nullable(revisionSchema),
        qualificationId: idSchema,
        qualifiedAt: nullable(timestampSchema),
      }),
    ),
    refusal: nullable(
      strictObject({
        message: pipe(string(), minLength(1), maxLength(DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters)),
        reason: picklist(DELEGATION_REFUSAL_REASONS),
      }),
    ),
    request: strictObject({
      action: textSchema,
      checkoutPath: absolutePathSchema,
      constraints: lineList(DELEGATION_BOUNDS.maxConstraints, DELEGATION_BOUNDS.maxConstraintCharacters),
      criteria: lineList(DELEGATION_BOUNDS.maxCriteria, DELEGATION_BOUNDS.maxCriterionCharacters),
      objective: pipe(string(), minLength(1), maxLength(DELEGATION_BOUNDS.maxObjectiveCharacters)),
      scope: delegationScopeRequestSchema,
      taskCategory: textSchema,
    }),
    requestedAt: timestampSchema,
    reservation: strictObject({
      evidence: nullable(picklist(DELEGATION_RELEASE_EVIDENCE)),
      held: boolean(),
      releasedAt: nullable(timestampSchema),
    }),
    result: nullable(delegationResultViewSchema),
    retryOf: nullable(idSchema),
    route: nullable(
      strictObject({
        accountScope: nullable(textSchema),
        context: nullable(contextSchema),
        effort: nullable(textSchema),
        harness: nullable(executorHarnessSchema),
        harnessVersion: nullable(textSchema),
        modelRequested: nullable(textSchema),
        /** `unknown` when the harness did not report the model it ran. */
        modelResolved: textSchema,
        poolId: nullable(idSchema),
        routeId: idSchema,
      }),
    ),
    selection: nullable(delegationSelectionSchema),
    startedAt: nullable(timestampSchema),
    state: picklist(DELEGATION_JOB_STATES),
    /** Three different facts: what ran, what a verification found, what the operator recorded. */
    status: strictObject({
      accepted: picklist(['pending', ...DELEGATION_ACCEPTANCE_VERDICTS]),
      executed: picklist(delegationExecutionStatuses),
      verified: picklist(['not-verified', ...DELEGATION_VERIFICATION_VERDICTS]),
    }),
    /** What the byte bound cut from this view, entry counts per list and free-text characters; the store keeps the whole record. */
    truncation: strictObject({
      automatedChecks: countSchema,
      characters: countSchema,
      constraints: countSchema,
      criteria: countSchema,
      evaluationChecks: countSchema,
      evaluations: countSchema,
      evidence: countSchema,
      findings: countSchema,
      guaranteeControls: countSchema,
      guaranteeLimits: countSchema,
      notReviewed: countSchema,
      rationale: countSchema,
      resultChecks: countSchema,
      resultLimits: countSchema,
      scopeFiles: countSchema,
    }),
    updatedAt: timestampSchema,
    usage: nullable(delegationUsageSchema),
  }),
  check((value) => serializedBytes(value) <= DELEGATION_BOUNDS.maxJobViewBytes, 'The job view exceeds its byte bound.'),
);

// ---------------------------------------------------------------------------------------------
// Inputs and outputs per procedure
// ---------------------------------------------------------------------------------------------

/** A JSON object the engine parses: a raw config section as the operator writes it. */
const jsonRecordSchema = pipe(
  record(string(), jsonWireValueSchema),
  check((value) => isJsonWireValue(value), 'Expected a finite, acyclic JSON object.'),
);

/**
 * The sections are the raw home-config sections (`routing.executors[]`, `routing.reviewTargets[]`,
 * `delegation`), bounded here and parsed strictly by the engine, which answers `invalid` with the
 * issues located by config path: the page shows why an entry was refused instead of a 400.
 */
export const delegationSaveSettingsInputSchema = pipe(
  strictObject({
    delegation: optional(jsonRecordSchema),
    executors: optional(pipe(array(jsonRecordSchema), maxLength(EXECUTOR_BOUNDS.maxDeclarations))),
    expectedRevision: revisionSchema,
    reviewTargets: optional(pipe(array(jsonRecordSchema), maxLength(REVIEW_ATTEMPT_BOUNDS.maxReviewTargets))),
  }),
  check(
    (value) => value.delegation !== undefined || value.executors !== undefined || value.reviewTargets !== undefined,
    'A save names at least one section.',
  ),
  check(
    (value) => serializedBytes(value) <= DELEGATION_WEB_BOUNDS.maxSaveInputBytes,
    'The settings exceed their byte bound.',
  ),
);

export const delegationSaveSettingsOutputSchema = strictObject({
  /** Always empty on a write; an `invalid` answer travels as `InvalidInput` with its issues. */
  issues: issuesSchema,
  result: literal('written'),
  revision: revisionSchema,
});

export const delegationSimulateInputSchema = strictObject({
  checkoutPath: absolutePathSchema,
  objective: optional(pipe(string(), minLength(1), maxLength(DELEGATION_BOUNDS.maxObjectiveCharacters))),
  scope: delegationScopeRequestSchema,
  taskCategory: taskCategorySchema,
});

export const delegationJobsInputSchema = strictObject({
  limit: optional(pipe(number(), safeInteger(), minValue(1), maxValue(DELEGATION_WEB_BOUNDS.maxListLimit))),
  liveOnly: optional(boolean()),
});

export const delegationJobsOutputSchema = strictObject({
  jobs: pipe(array(delegationJobViewSchema), maxLength(DELEGATION_WEB_BOUNDS.maxListLimit)),
  /** Trailing (older) jobs the server dropped to keep the answer under `maxJobsListBytes`; counted, never silent. */
  omitted: countSchema,
  /** Stored rows the reader refused on re-validation; never silently omitted. */
  skipped: countSchema,
});

export const delegationJobInputSchema = strictObject({ jobId: uuidSchema });

export const delegationCancelInputSchema = strictObject({ jobId: uuidSchema });

export const delegationCancelOutputSchema = strictObject({
  jobId: uuidSchema,
  result: picklist(DELEGATION_CANCEL_RESULTS),
  state: nullable(picklist(DELEGATION_JOB_STATES)),
});

/** The operator's acceptance; the author is this edge's (`operator`), never part of the input. */
export const delegationRecordAcceptanceInputSchema = strictObject({
  jobId: uuidSchema,
  note: optional(pipe(string(), minLength(1), maxLength(DELEGATION_BOUNDS.maxEvaluationNoteCharacters))),
  verdict: picklist(DELEGATION_ACCEPTANCE_VERDICTS),
});

export const delegationRecordAcceptanceOutputSchema = strictObject({ evaluationId: idSchema });

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A revision conflict carries the current revision so the page can re-read and retry. */
export const delegationConflictDataSchema = strictObject({
  reason: optional(publicReasonSchema),
  revision: optional(revisionSchema),
});

/** An invalid write carries the engine's issues by config path; a refused evaluation its reason. */
export const delegationInvalidInputDataSchema = strictObject({
  issues: optional(issuesSchema),
  reason: optional(publicReasonSchema),
});

const readErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  IncompatibleStore: publicErrorMap.IncompatibleStore,
  Unavailable: publicErrorMap.Unavailable,
} as const;

const saveSettingsErrors = {
  Conflict: { data: delegationConflictDataSchema },
  EngineUnavailable: publicErrorMap.EngineUnavailable,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: { data: delegationInvalidInputDataSchema },
  Unavailable: publicErrorMap.Unavailable,
} as const;

const simulateErrors = {
  EngineUnavailable: publicErrorMap.EngineUnavailable,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: { data: delegationInvalidInputDataSchema },
  Unavailable: publicErrorMap.Unavailable,
} as const;

const cancelErrors = {
  EngineUnavailable: publicErrorMap.EngineUnavailable,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: { data: delegationInvalidInputDataSchema },
  Unavailable: publicErrorMap.Unavailable,
} as const;

const recordAcceptanceErrors = {
  Conflict: { data: delegationConflictDataSchema },
  EngineUnavailable: publicErrorMap.EngineUnavailable,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: { data: delegationInvalidInputDataSchema },
  Unavailable: publicErrorMap.Unavailable,
} as const;

/** Reasons the `job` read answers `Unavailable` with when the entity is absent. */
export const DELEGATION_JOB_NOT_FOUND_REASON = 'job-not-found' as const;

// ---------------------------------------------------------------------------------------------
// Types, parsers, contract
// ---------------------------------------------------------------------------------------------

export type DelegationIssueWire = InferOutput<typeof delegationIssueSchema>;
export type DelegationScopeRequestWire = InferOutput<typeof delegationScopeRequestSchema>;
export type DelegationConfigWire = InferOutput<typeof delegationConfigSchema>;
export type DelegationModelEntryWire = InferOutput<typeof delegationModelEntrySchema>;
export type DelegationRuleWire = InferOutput<typeof delegationRuleSchema>;
export type DelegationRouteAnnotationWire = InferOutput<typeof delegationRouteAnnotationSchema>;
export type DelegationRouteStatus = InferOutput<typeof delegationRouteStatusSchema>;
export type DelegationHarnessSupport = InferOutput<typeof delegationHarnessSupportSchema>;
export type DelegationSettingsView = InferOutput<typeof delegationSettingsViewSchema>;
export type DelegationQualificationWire = InferOutput<typeof delegationQualificationSchema>;
export type DelegationQualifiedRouteWire = InferOutput<typeof delegationQualifiedRouteSchema>;
export type DelegationEvaluationViewWire = InferOutput<typeof delegationEvaluationViewSchema>;
export type DelegationResultViewWire = InferOutput<typeof delegationResultViewSchema>;
export type DelegationFindingWire = InferOutput<typeof delegationFindingSchema>;
export type DelegationGuaranteeWire = InferOutput<typeof delegationGuaranteeSchema>;
export type DelegationSelectionWire = InferOutput<typeof delegationSelectionSchema>;
export type DelegationJobViewWire = InferOutput<typeof delegationJobViewSchema>;
export type DelegationSaveSettingsInput = InferOutput<typeof delegationSaveSettingsInputSchema>;
export type DelegationSaveSettingsOutput = InferOutput<typeof delegationSaveSettingsOutputSchema>;
export type DelegationSimulateInput = InferOutput<typeof delegationSimulateInputSchema>;
export type DelegationJobsInput = InferOutput<typeof delegationJobsInputSchema>;
export type DelegationJobsOutput = InferOutput<typeof delegationJobsOutputSchema>;
export type DelegationJobInput = InferOutput<typeof delegationJobInputSchema>;
export type DelegationCancelInput = InferOutput<typeof delegationCancelInputSchema>;
export type DelegationCancelOutput = InferOutput<typeof delegationCancelOutputSchema>;
export type DelegationRecordAcceptanceInput = InferOutput<typeof delegationRecordAcceptanceInputSchema>;
export type DelegationRecordAcceptanceOutput = InferOutput<typeof delegationRecordAcceptanceOutputSchema>;
export type DelegationConflictData = InferOutput<typeof delegationConflictDataSchema>;
export type DelegationInvalidInputData = InferOutput<typeof delegationInvalidInputDataSchema>;
export type DelegationSaveSection = JsonWireValue;

export const parseDelegationSettingsView = (value: unknown): DelegationSettingsView =>
  parse(delegationSettingsViewSchema, value);
export const parseDelegationSaveSettingsOutput = (value: unknown): DelegationSaveSettingsOutput =>
  parse(delegationSaveSettingsOutputSchema, value);
export const parseDelegationQualificationWire = (value: unknown): DelegationQualificationWire =>
  parse(delegationQualificationSchema, value);
export const parseDelegationJobsOutput = (value: unknown): DelegationJobsOutput =>
  parse(delegationJobsOutputSchema, value);
export const parseDelegationJobView = (value: unknown): DelegationJobViewWire => parse(delegationJobViewSchema, value);
export const parseDelegationCancelOutput = (value: unknown): DelegationCancelOutput =>
  parse(delegationCancelOutputSchema, value);
export const parseDelegationRecordAcceptanceOutput = (value: unknown): DelegationRecordAcceptanceOutput =>
  parse(delegationRecordAcceptanceOutputSchema, value);

export const delegationContract = {
  settings: oc
    .route({ method: 'GET', path: '/delegation/settings' })
    .input(emptyInputSchema)
    .output(delegationSettingsViewSchema)
    .errors(readErrors),
  saveSettings: oc
    .route({ method: 'POST', path: '/delegation/settings' })
    .input(delegationSaveSettingsInputSchema)
    .output(delegationSaveSettingsOutputSchema)
    .errors(saveSettingsErrors),
  simulate: oc
    .route({ method: 'POST', path: '/delegation/simulate' })
    .input(delegationSimulateInputSchema)
    .output(delegationQualificationSchema)
    .errors(simulateErrors),
  jobs: oc
    .route({ method: 'GET', path: '/delegation/jobs' })
    .input(delegationJobsInputSchema)
    .output(delegationJobsOutputSchema)
    .errors(readErrors),
  job: oc
    .route({ method: 'GET', path: '/delegation/job' })
    .input(delegationJobInputSchema)
    .output(delegationJobViewSchema)
    .errors(readErrors),
  cancel: oc
    .route({ method: 'POST', path: '/delegation/cancel' })
    .input(delegationCancelInputSchema)
    .output(delegationCancelOutputSchema)
    .errors(cancelErrors),
  recordAcceptance: oc
    .route({ method: 'POST', path: '/delegation/acceptance' })
    .input(delegationRecordAcceptanceInputSchema)
    .output(delegationRecordAcceptanceOutputSchema)
    .errors(recordAcceptanceErrors),
} as const;

export type DelegationContractClient = ContractRouterClient<typeof delegationContract>;
