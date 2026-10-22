import { REVIEW_ATTEMPT_BOUNDS } from '@ai-usage/report-core/work-attempts';
import { EXECUTOR_BOUNDS } from '@ai-usage/report-core/work-executors';
import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  custom,
  type InferOutput,
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
} from 'valibot';
import { publicErrorMap } from './errors';
import { emptyInputSchema, isJsonWireValue } from './schema-conventions';

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

export const executorDeclaredTargetSchema = union([
  strictObject({ kind: picklist(['any-local-session']) }),
  strictObject({ kind: picklist(['project']), projectLabel: textSchema }),
]);

export const executorDeclarationSchema = strictObject({
  accountScope: scopeSchema,
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

const workRoutingErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  Unavailable: publicErrorMap.Unavailable,
} as const;

export const workRoutingContract = {
  context: oc
    .route({ method: 'GET', path: '/work/routing-context' })
    .input(emptyInputSchema)
    .output(workRoutingContextSchema)
    .errors(workRoutingErrors),
} as const;

export type WorkRoutingContractClient = ContractRouterClient<typeof workRoutingContract>;
