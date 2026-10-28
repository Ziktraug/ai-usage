import { REVIEW_ATTEMPT_BOUNDS } from '@ai-usage/report-core/work-attempts';
import { EXECUTOR_BOUNDS } from '@ai-usage/report-core/work-executors';
import {
  CANDIDATE_IDENTITY_STATES,
  isExecutorAccountFingerprint,
  ROUTING_QUALIFICATION_BOUNDS,
} from '@ai-usage/report-core/work-routing-vocabulary';
import type { ContractRouterClient } from '@orpc/contract';
import {
  array,
  boolean,
  custom,
  type InferOutput,
  literal,
  maxLength,
  minLength,
  nullable,
  optional,
  parse,
  picklist,
  pipe,
  strictObject,
  string,
  union,
  variant,
} from 'valibot';
import { publicErrorMap } from './errors';
import { rpcProcedure } from './rpc-procedure';
import { emptyInputSchema, isJsonWireValue, jsonWireValueSchema, publicMessageSchema } from './schema-conventions';

/**
 * The review-routing context the Work view qualifies candidates from: the operator's declarations
 * (read from the home config, with the entries that failed and why), and the engine's latest
 * executor observations. Quota is not restated here; it keeps its own feed (ADR 0045).
 *
 * Nothing in this contract authorizes or starts anything, and no field may carry a credential:
 * evidence strings are bounded classifications, issues name a config path and a reason, never a
 * value.
 */
const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const timestampSchema = custom<string>(isStrictIsoTimestamp, 'Expected a canonical ISO timestamp.');
const scopeSchema = pipe(string(), minLength(1), maxLength(EXECUTOR_BOUNDS.maxScope));
const textSchema = pipe(string(), minLength(1), maxLength(EXECUTOR_BOUNDS.maxText));
const pathSchema = pipe(string(), minLength(1), maxLength(EXECUTOR_BOUNDS.maxPath));
const issueTextSchema = pipe(string(), minLength(1), maxLength(512));

const executorHarnessSchema = picklist(['claude-code', 'codex']);
/** ADR 0057: the truncated hash the collector derives; never the account identifiers themselves. */
const accountFingerprintSchema = custom<string>(
  isExecutorAccountFingerprint,
  'Expected a lowercase hexadecimal account fingerprint.',
);

export const executorDeclaredTargetSchema = union([
  strictObject({ kind: picklist(['any-local-session']) }),
  strictObject({ kind: picklist(['project']), projectLabel: textSchema }),
]);

export const executorDeclarationSchema = strictObject({
  accountFingerprint: optional(accountFingerprintSchema),
  accountScope: scopeSchema,
  alternateModels: optional(pipe(array(textSchema), minLength(1), maxLength(EXECUTOR_BOUNDS.maxAlternateModels))),
  authorization: picklist(['allowed', 'forbidden']),
  capabilities: pipe(array(picklist(['read-only-review'])), maxLength(1)),
  declaredAt: timestampSchema,
  effort: nullable(textSchema),
  harness: executorHarnessSchema,
  machineId: scopeSchema,
  model: nullable(textSchema),
  quality: picklist(['review-capable']),
  subscription: picklist(['verified', 'api']),
  targets: pipe(array(executorDeclaredTargetSchema), minLength(1), maxLength(EXECUTOR_BOUNDS.maxTargets)),
});

export const executorObservationSchema = strictObject({
  accountFingerprint: optional(accountFingerprintSchema),
  authEvidence: textSchema,
  authMethod: nullable(pipe(string(), minLength(1), maxLength(EXECUTOR_BOUNDS.maxAuthMethod))),
  authState: picklist(['logged-in', 'logged-out', 'unknown']),
  binaryPath: nullable(pathSchema),
  harness: executorHarnessSchema,
  machineId: scopeSchema,
  observedAt: timestampSchema,
  outcome: picklist(['observed', 'unavailable', 'timeout', 'invalid']),
  version: nullable(textSchema),
});

export const workRoutingContextSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON routing context without accessors.'),
  strictObject({
    /** Config path of the declarations file, so the operator knows what to edit; never its content. */
    configPath: nullable(pathSchema),
    /** `routing.executors[<i>].<field>: <reason>` for each rejected entry; values are never echoed. */
    declarationErrors: pipe(array(issueTextSchema), maxLength(EXECUTOR_BOUNDS.maxDeclarations + 1)),
    declarations: pipe(array(executorDeclarationSchema), maxLength(EXECUTOR_BOUNDS.maxDeclarations)),
    executorObservations: pipe(array(executorObservationSchema), maxLength(EXECUTOR_BOUNDS.maxObservations)),
    generatedAt: timestampSchema,
    /** This machine's identity, the default `machineId` of a declaration; `null` before the engine created one. */
    machineId: nullable(scopeSchema),
    /** Latest observations the reader refused on re-validation, and whether its bound was reached. */
    observationRead: optional(
      strictObject({
        skipped: pipe(custom<number>((value) => Number.isSafeInteger(value) && Number(value) >= 0)),
        truncated: custom<boolean>((value) => typeof value === 'boolean'),
      }),
    ),
    /** `routing.reviewTargets[<i>].<field>: <reason>` for each rejected checkout entry (ADR 0053). */
    reviewTargetErrors: optional(pipe(array(issueTextSchema), maxLength(REVIEW_ATTEMPT_BOUNDS.maxReviewTargets + 1))),
    /** Checkouts a launched review may run in; a session outside all of them cannot be reviewed. */
    reviewTargets: optional(
      pipe(
        array(strictObject({ checkoutPath: pathSchema, label: nullable(textSchema) })),
        maxLength(REVIEW_ATTEMPT_BOUNDS.maxReviewTargets),
      ),
    ),
  }),
);

export type ExecutorDeclarationWire = InferOutput<typeof executorDeclarationSchema>;
export type ExecutorObservationWire = InferOutput<typeof executorObservationSchema>;
export type WorkRoutingContext = InferOutput<typeof workRoutingContextSchema>;

export const parseWorkRoutingContext = (value: unknown): WorkRoutingContext => parse(workRoutingContextSchema, value);

/**
 * `workRouting.qualify` (ADR 0057): asks the engine to observe the executors now and decide who may
 * review this target. The answer is the engine's decision with its reasons and limits; it starts
 * nothing, grants nothing and carries no quota window, only the verdicts drawn from them.
 */
const qualificationTextSchema = pipe(string(), minLength(1), maxLength(ROUTING_QUALIFICATION_BOUNDS.maxText));
const qualificationListSchema = pipe(
  array(qualificationTextSchema),
  maxLength(ROUTING_QUALIFICATION_BOUNDS.maxEntries),
);
const qualificationIdSchema = pipe(string(), minLength(1), maxLength(ROUTING_QUALIFICATION_BOUNDS.maxId));
const targetIdentitySchema = pipe(string(), minLength(1), maxLength(EXECUTOR_BOUNDS.maxScope));

export const workRoutingQualifyInputSchema = strictObject({
  target: strictObject({
    desktopSessionId: optional(nullable(targetIdentitySchema)),
    harness: targetIdentitySchema,
    sourceSessionId: targetIdentitySchema,
  }),
});

export const workRoutingQualificationSchema = strictObject({
  candidates: pipe(
    array(
      strictObject({
        accountScope: nullable(qualificationIdSchema),
        actions: qualificationListSchema,
        candidateId: qualificationIdSchema,
        eligible: boolean(),
        exclusionReasons: qualificationListSchema,
        harness: executorHarnessSchema,
        identity: nullable(
          strictObject({
            declared: nullable(accountFingerprintSchema),
            observed: nullable(accountFingerprintSchema),
            observedAt: nullable(timestampSchema),
            state: picklist(CANDIDATE_IDENTITY_STATES),
          }),
        ),
        missingData: qualificationListSchema,
        model: nullable(qualificationTextSchema),
      }),
    ),
    maxLength(ROUTING_QUALIFICATION_BOUNDS.maxCandidates),
  ),
  chosenCandidateId: nullable(qualificationIdSchema),
  executors: strictObject({
    outcome: picklist(['disabled', 'failed', 'not-detected', 'not-run', 'skipped', 'success', 'timed-out', 'warning']),
    refreshed: boolean(),
  }),
  omittedCandidates: custom<number>((value) => Number.isSafeInteger(value) && Number(value) >= 0),
  qualifiedAt: timestampSchema,
  reasons: qualificationListSchema,
  recommendation: strictObject({
    candidateId: nullable(qualificationIdSchema),
    kind: picklist(['real', 'conditional', 'none']),
    missing: nullable(qualificationTextSchema),
  }),
});

export const workRoutingQualifyErrorTags = ['ForbiddenDemo', 'Unavailable'] as const;

export const workRoutingQualifyOutputSchema = pipe(
  jsonWireValueSchema,
  variant('ok', [
    strictObject({ data: workRoutingQualificationSchema, ok: literal(true) }),
    strictObject({
      error: strictObject({ message: publicMessageSchema, tag: picklist(workRoutingQualifyErrorTags) }),
      ok: literal(false),
    }),
  ]),
);

export type WorkRoutingQualifyInput = InferOutput<typeof workRoutingQualifyInputSchema>;
export type WorkRoutingQualification = InferOutput<typeof workRoutingQualificationSchema>;
export type WorkRoutingQualifyOutput = InferOutput<typeof workRoutingQualifyOutputSchema>;

export const parseWorkRoutingQualifyOutput = (value: unknown): WorkRoutingQualifyOutput =>
  parse(workRoutingQualifyOutputSchema, value);

const workRoutingErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  Unavailable: publicErrorMap.Unavailable,
} as const;

export const workRoutingContract = {
  context: rpcProcedure({
    errors: workRoutingErrors,
    method: 'GET',
    path: '/work/routing-context',
    requestSize: 'none',
    responseSize: 'bounded-json',
    transport: 'query',
  })
    .input(emptyInputSchema)
    .output(workRoutingContextSchema),
  qualify: rpcProcedure({
    errors: {
      EngineUnavailable: publicErrorMap.EngineUnavailable,
      Forbidden: publicErrorMap.Forbidden,
      ForbiddenDemo: publicErrorMap.ForbiddenDemo,
      InvalidInput: publicErrorMap.InvalidInput,
    },
    method: 'POST',
    path: '/work/routing-qualification',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    transport: 'mutation',
  })
    .input(workRoutingQualifyInputSchema)
    .output(workRoutingQualifyOutputSchema),
} as const;

export type WorkRoutingContractClient = ContractRouterClient<typeof workRoutingContract>;
