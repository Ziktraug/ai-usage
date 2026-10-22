import {
  REVIEW_ATTEMPT_ACCEPTANCES,
  REVIEW_ATTEMPT_BOUNDS,
  REVIEW_ATTEMPT_RESULT_KINDS,
  REVIEW_ATTEMPT_STATES,
  REVIEW_CHECKOUT_ORIGINS,
  REVIEW_LAUNCH_REFUSAL_REASONS,
} from '@ai-usage/report-core/work-attempts';
import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  boolean,
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
  safeInteger,
  strictObject,
  string,
  variant,
} from 'valibot';
import { jsonWireValueSchema, publicMessageSchema } from './schema-conventions';

/**
 * Review attempts (ADR 0053): the executions the engine launched for the operator, read back and
 * started from the Work view. Both procedures answer an envelope, like `work.attention`: a refusal
 * ("add routing.reviewTargets for …") is data the page renders beside the button, not a transport
 * error. Nothing in this contract carries a transcript, a declaration snapshot, a pid or an
 * idempotency key; the result excerpt is bounded and the native session id is the only link to the
 * harness's own session.
 */
const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const timestampSchema = custom<string>(isStrictIsoTimestamp, 'Expected a canonical ISO timestamp.');
const idSchema = pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxId));
const harnessSchema = pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxText));
const shortTextSchema = pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxText));
const pathSchema = pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxPath));
const countSchema = pipe(number(), safeInteger(), minValue(0));

export const workAttemptTargetSchema = strictObject({
  checkoutOrigin: nullable(picklist(REVIEW_CHECKOUT_ORIGINS)),
  checkoutPath: nullable(pathSchema),
  desktopSessionId: nullable(idSchema),
  harness: harnessSchema,
  projectLabel: nullable(shortTextSchema),
  sessionTitle: nullable(shortTextSchema),
  sourceSessionId: idSchema,
});

export const workAttemptSchema = strictObject({
  /** Human acceptance, distinct from the result; always `pending` in this version (no mutation exists). */
  acceptance: picklist(REVIEW_ATTEMPT_ACCEPTANCES),
  attemptId: idSchema,
  candidateId: idSchema,
  /** The declared account, model and effort the launch rested on; `null` for a refusal. */
  declared: nullable(
    strictObject({
      accountScope: shortTextSchema,
      effort: nullable(shortTextSchema),
      model: nullable(shortTextSchema),
    }),
  ),
  durationMs: nullable(countSchema),
  endedAt: nullable(timestampSchema),
  executorHarness: picklist(['claude-code', 'codex']),
  exitCode: nullable(pipe(number(), safeInteger())),
  failureReason: nullable(pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxFailureReason))),
  machineId: shortTextSchema,
  nativeSessionId: nullable(idSchema),
  /** The served Session row for the native session once the report collected it; the link target of "Open session detail". */
  nativeSessionRowId: nullable(idSchema),
  numTurns: nullable(countSchema),
  requestedAt: timestampSchema,
  resultExcerpt: nullable(pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxExcerpt))),
  resultKind: nullable(picklist(REVIEW_ATTEMPT_RESULT_KINDS)),
  startedAt: nullable(timestampSchema),
  state: picklist(REVIEW_ATTEMPT_STATES),
  target: workAttemptTargetSchema,
  updatedAt: timestampSchema,
  /** Verification commands the review actually ran: empty for a read-only review, never invented. */
  validations: pipe(
    array(pipe(string(), minLength(1), maxLength(REVIEW_ATTEMPT_BOUNDS.maxValidationText))),
    maxLength(REVIEW_ATTEMPT_BOUNDS.maxValidations),
  ),
});

const targetSelectorSchema = strictObject({ harness: harnessSchema, sourceSessionId: idSchema });

export const workAttemptsListInputSchema = strictObject({
  limit: optional(pipe(number(), safeInteger(), minValue(1), maxValue(REVIEW_ATTEMPT_BOUNDS.maxListLimit))),
  target: optional(targetSelectorSchema),
});

/** What the server could resolve about the requested target, so the page can say why no launch is possible. */
export const workAttemptsResolvedTargetSchema = strictObject({
  /** Whether the resolved checkout is inside a declared `routing.reviewTargets[]` entry; the engine re-decides. */
  admitted: boolean(),
  checkoutOrigin: nullable(picklist(REVIEW_CHECKOUT_ORIGINS)),
  checkoutPath: nullable(pathSchema),
  harness: harnessSchema,
  sourceSessionId: idSchema,
});

export const workAttemptsListDataSchema = strictObject({
  attempts: pipe(array(workAttemptSchema), maxLength(REVIEW_ATTEMPT_BOUNDS.maxListLimit)),
  generatedAt: timestampSchema,
  /** Stored rows the reader refused on re-validation; never silently omitted. */
  skipped: countSchema,
  target: nullable(workAttemptsResolvedTargetSchema),
  truncated: boolean(),
});

export const workAttemptsListErrorTags = ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'] as const;

export const workAttemptsListOutputSchema = pipe(
  jsonWireValueSchema,
  variant('ok', [
    strictObject({ data: workAttemptsListDataSchema, ok: literal(true) }),
    strictObject({
      error: strictObject({ message: publicMessageSchema, tag: picklist(workAttemptsListErrorTags) }),
      ok: literal(false),
    }),
  ]),
);

export const workAttemptsStartInputSchema = strictObject({
  action: literal('read-only-review'),
  candidateId: idSchema,
  target: strictObject({
    desktopSessionId: optional(nullable(idSchema)),
    harness: harnessSchema,
    sourceSessionId: idSchema,
  }),
});

export const workAttemptsStartErrorTags = ['Refused', 'ForbiddenDemo', 'Unavailable'] as const;

export const workAttemptsStartOutputSchema = pipe(
  jsonWireValueSchema,
  variant('ok', [
    strictObject({
      data: strictObject({ attemptId: idSchema, reused: boolean(), state: picklist(REVIEW_ATTEMPT_STATES) }),
      ok: literal(true),
    }),
    strictObject({
      error: strictObject({
        message: publicMessageSchema,
        /** The typed refusal; `null` for a demo or availability failure. */
        reason: nullable(picklist(REVIEW_LAUNCH_REFUSAL_REASONS)),
        tag: picklist(workAttemptsStartErrorTags),
      }),
      ok: literal(false),
    }),
  ]),
);

export type WorkAttemptWire = InferOutput<typeof workAttemptSchema>;
export type WorkAttemptsListInput = InferOutput<typeof workAttemptsListInputSchema>;
export type WorkAttemptsListData = InferOutput<typeof workAttemptsListDataSchema>;
export type WorkAttemptsListOutput = InferOutput<typeof workAttemptsListOutputSchema>;
export type WorkAttemptsListErrorTag = (typeof workAttemptsListErrorTags)[number];
export type WorkAttemptsResolvedTarget = InferOutput<typeof workAttemptsResolvedTargetSchema>;
export type WorkAttemptsStartInput = InferOutput<typeof workAttemptsStartInputSchema>;
export type WorkAttemptsStartOutput = InferOutput<typeof workAttemptsStartOutputSchema>;
export type WorkAttemptsStartErrorTag = (typeof workAttemptsStartErrorTags)[number];

export const parseWorkAttemptsListOutput = (value: unknown): WorkAttemptsListOutput =>
  parse(workAttemptsListOutputSchema, value);
export const parseWorkAttemptsStartOutput = (value: unknown): WorkAttemptsStartOutput =>
  parse(workAttemptsStartOutputSchema, value);

export const workAttemptsContract = {
  list: oc
    .route({ method: 'POST', path: '/work/attempts' })
    .input(workAttemptsListInputSchema)
    .output(workAttemptsListOutputSchema),
  start: oc
    .route({ method: 'POST', path: '/work/attempts/start' })
    .input(workAttemptsStartInputSchema)
    .output(workAttemptsStartOutputSchema),
} as const;

export type WorkAttemptsContractClient = ContractRouterClient<typeof workAttemptsContract>;
