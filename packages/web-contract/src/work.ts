import { isCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  CHECKOUT_STATUS_OUTCOMES,
  CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS,
  CLAUDE_DESKTOP_TITLE_SOURCES,
  CLAUDE_DESKTOP_TURN_STATUSES,
  JIRA_ISSUE_KEY_PATTERN,
  JIRA_ISSUE_OBSERVATION_OUTCOMES,
  JIRA_STATUS_CATEGORIES,
  PULL_REQUEST_CHECK_ROLLUPS,
  PULL_REQUEST_OBSERVATION_OUTCOMES,
  PULL_REQUEST_STATES,
  WORK_ATTENTION_BOUNDS,
  WORK_ATTENTION_KINDS,
  WORK_FACT_SOURCES,
  WORK_INTERPRETATION_KINDS,
} from '@ai-usage/report-core/work-attention';
import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  boolean,
  check,
  finite,
  type InferOutput,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  null_,
  nullable,
  number,
  optional,
  parse,
  picklist,
  pipe,
  regex,
  safeInteger,
  strictObject,
  string,
  variant,
} from 'valibot';
import { jsonWireValueSchema, publicMessageSchema } from './schema-conventions';

/**
 * The Work attention procedure (ADR 0050). The output mirrors `WorkAttentionDataset` from
 * `@ai-usage/report-core/work-attention` field for field, under the same bounds, so a root the
 * read model built is exactly a root the browser receives. Failures travel inside the envelope,
 * tagged with an existing public error family, so the page can render "unavailable" and
 * "read-only in demo" without a second contract.
 */

const {
  maxChildrenTitles,
  maxDetailText,
  maxFacts,
  maxId,
  maxInterpretations,
  maxPath,
  maxReportText,
  maxRoots,
  maxShortText,
} = WORK_ATTENTION_BOUNDS;

const MAX_INTERPRETATION_TEXT = 1024;
const MAX_REVISION_LENGTH = 256;

const instantSchema = pipe(
  string(),
  check((value: string) => isCanonicalInstant(value), 'Expected a canonical ISO timestamp.'),
);
const identifierSchema = pipe(string(), minLength(1), maxLength(maxId));
const shortTextSchema = pipe(string(), maxLength(maxShortText));
const detailTextSchema = pipe(string(), maxLength(maxDetailText));
const reportTextSchema = pipe(string(), maxLength(maxReportText));
const pathTextSchema = pipe(string(), maxLength(maxPath));
const countSchema = pipe(number(), finite(), safeInteger(), minValue(0));
const jiraKeySchema = pipe(string(), maxLength(maxShortText), regex(JIRA_ISSUE_KEY_PATTERN));
const positiveIntegerSchema = pipe(number(), finite(), safeInteger(), minValue(1));

const provenanceSchema = strictObject({
  coverage: picklist(['complete', 'partial']),
  machineId: identifierSchema,
  observedAt: instantSchema,
  source: picklist(WORK_FACT_SOURCES),
});

const factBase = { id: identifierSchema, provenance: provenanceSchema } as const;

export const workFactSchema = variant('kind', [
  strictObject({
    ...factBase,
    declaredAt: instantSchema,
    desktopSessionId: identifierSchema,
    detail: detailTextSchema,
    kind: literal('declared-turn'),
    needsAction: nullable(detailTextSchema),
    status: picklist(CLAUDE_DESKTOP_TURN_STATUSES),
  }),
  strictObject({
    ...factBase,
    branch: nullable(shortTextSchema),
    declaredBy: picklist(['root', 'child']),
    host: shortTextSchema,
    kind: literal('declared-pull-request'),
    lastActivityAt: instantSchema,
    number: positiveIntegerSchema,
    repository: shortTextSchema,
    state: shortTextSchema,
    url: nullable(pathTextSchema),
  }),
  strictObject({
    ...factBase,
    accountLabel: nullable(shortTextSchema),
    checksRollup: nullable(picklist(PULL_REQUEST_CHECK_ROLLUPS)),
    draft: nullable(boolean()),
    host: shortTextSchema,
    kind: literal('pull-request'),
    mergedAt: nullable(instantSchema),
    number: positiveIntegerSchema,
    outcome: picklist(PULL_REQUEST_OBSERVATION_OUTCOMES),
    repository: shortTextSchema,
    reviewDecision: nullable(shortTextSchema),
    state: nullable(picklist(PULL_REQUEST_STATES)),
    updatedAt: nullable(instantSchema),
    url: nullable(pathTextSchema),
  }),
  strictObject({
    ...factBase,
    ahead: nullable(countSchema),
    behind: nullable(countSchema),
    branch: nullable(shortTextSchema),
    checkoutPath: pathTextSchema,
    dirty: nullable(boolean()),
    kind: literal('checkout-status'),
    lastCommitAt: nullable(instantSchema),
    modifiedCount: nullable(countSchema),
    outcome: picklist(CHECKOUT_STATUS_OUTCOMES),
    stagedCount: nullable(countSchema),
    untrackedCount: nullable(countSchema),
  }),
  strictObject({
    ...factBase,
    commentCount: nullable(countSchema),
    key: jiraKeySchema,
    kind: literal('jira-issue'),
    newCommentsSince: nullable(countSchema),
    newestCommentAt: nullable(instantSchema),
    outcome: picklist(JIRA_ISSUE_OBSERVATION_OUTCOMES),
    status: nullable(shortTextSchema),
    statusCategory: nullable(picklist(JIRA_STATUS_CATEGORIES)),
    updatedAt: nullable(instantSchema),
    url: null_(),
  }),
  strictObject({
    ...factBase,
    createdAt: nullable(instantSchema),
    kind: literal('proposal'),
    resolution: picklist(['open', ...CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS]),
    suggestionId: identifierSchema,
    title: shortTextSchema,
    tldr: nullable(detailTextSchema),
  }),
  strictObject({ ...factBase, at: instantSchema, kind: literal('wrap-up'), text: reportTextSchema }),
  strictObject({ ...factBase, at: instantSchema, kind: literal('turn-report'), text: reportTextSchema }),
  strictObject({ ...factBase, branch: shortTextSchema, kind: literal('written-branch') }),
  strictObject({
    ...factBase,
    desktopSessionId: identifierSchema,
    kind: literal('spawned-from'),
    taskId: nullable(identifierSchema),
    title: nullable(shortTextSchema),
  }),
  strictObject({
    ...factBase,
    at: instantSchema,
    kind: literal('side-session-note'),
    report: reportTextSchema,
    sessionId: identifierSchema,
    title: shortTextSchema,
  }),
]);

export const workInterpretationSchema = strictObject({
  evidence: pipe(array(identifierSchema), maxLength(maxFacts)),
  kind: picklist(WORK_INTERPRETATION_KINDS),
  text: pipe(string(), minLength(1), maxLength(MAX_INTERPRETATION_TEXT)),
  uncertainty: pipe(string(), minLength(1), maxLength(maxDetailText)),
});

export const workRootSchema = strictObject({
  age: strictObject({
    createdAt: nullable(instantSchema),
    declaredAt: nullable(instantSchema),
    lastActivityAt: nullable(instantSchema),
    lastObservedAt: nullable(instantSchema),
  }),
  archived: boolean(),
  attention: picklist(WORK_ATTENTION_KINDS),
  children: strictObject({
    blocked: countSchema,
    completed: countSchema,
    count: countSchema,
    reviewReady: countSchema,
    titles: pipe(array(shortTextSchema), maxLength(maxChildrenTitles)),
  }),
  declared: nullable(
    strictObject({
      at: instantSchema,
      detail: detailTextSchema,
      needsAction: nullable(detailTextSchema),
      status: picklist(CLAUDE_DESKTOP_TURN_STATUSES),
    }),
  ),
  desktopSessionId: nullable(identifierSchema),
  facts: pipe(array(workFactSchema), maxLength(maxFacts)),
  interpretations: pipe(array(workInterpretationSchema), maxLength(maxInterpretations)),
  key: strictObject({ harness: shortTextSchema, machineId: identifierSchema, sourceSessionId: identifierSchema }),
  project: strictObject({
    branch: nullable(shortTextSchema),
    checkoutPath: nullable(pathTextSchema),
    // Labels are a directory name or the report's free text; both are bounded like a path.
    label: pathTextSchema,
    servedLabel: nullable(pathTextSchema),
    worktreeName: nullable(shortTextSchema),
  }),
  reconsidered: boolean(),
  session: nullable(strictObject({ campaignKey: nullable(identifierSchema), rowId: identifierSchema })),
  title: shortTextSchema,
  titleSource: picklist(CLAUDE_DESKTOP_TITLE_SOURCES),
});

export const workAttentionCoverageSchema = strictObject({
  checkouts: strictObject({ failed: countSchema, lastRunAt: nullable(instantSchema), observed: countSchema }),
  codexSessions: strictObject({ campaignsInWindow: countSchema, campaignsRead: countSchema }),
  desktopSessions: strictObject({
    collectedAt: nullable(instantSchema),
    filesParsed: countSchema,
    filesSeen: countSchema,
    refusedRows: countSchema,
    sessionsRead: countSchema,
    sessionsStored: countSchema,
    truncated: boolean(),
    unsupported: countSchema,
  }),
  jira: strictObject({
    disabled: boolean(),
    failed: countSchema,
    lastRunAt: nullable(instantSchema),
    observed: countSchema,
    reason: nullable(detailTextSchema),
  }),
  pullRequests: strictObject({
    disabled: boolean(),
    failed: countSchema,
    lastRunAt: nullable(instantSchema),
    observed: countSchema,
  }),
  sessions: strictObject({
    joined: countSchema,
    revision: nullable(pipe(string(), minLength(1), maxLength(MAX_REVISION_LENGTH))),
    unmatched: countSchema,
  }),
  window: strictObject({ excludedRoots: countSchema, sinceDays: positiveIntegerSchema }),
});

export const workAttentionDatasetSchema = strictObject({
  coverage: workAttentionCoverageSchema,
  generatedAt: instantSchema,
  machineId: nullable(identifierSchema),
  roots: pipe(array(workRootSchema), maxLength(maxRoots)),
  totalRoots: countSchema,
  truncated: boolean(),
});

export const workAttentionErrorTags = ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'] as const;
export type WorkAttentionErrorTag = (typeof workAttentionErrorTags)[number];

export const workAttentionInputSchema = strictObject({
  limit: optional(pipe(number(), finite(), safeInteger(), minValue(1), maxValue(maxRoots))),
  machineId: optional(nullable(identifierSchema)),
});

export const workAttentionOutputSchema = pipe(
  jsonWireValueSchema,
  variant('ok', [
    strictObject({ data: workAttentionDatasetSchema, ok: literal(true) }),
    strictObject({
      error: strictObject({ message: publicMessageSchema, tag: picklist(workAttentionErrorTags) }),
      ok: literal(false),
    }),
  ]),
);

export type WorkAttentionInput = InferOutput<typeof workAttentionInputSchema>;
export type WorkAttentionOutput = InferOutput<typeof workAttentionOutputSchema>;
export type WorkAttentionDatasetWire = InferOutput<typeof workAttentionDatasetSchema>;
export type WorkRootWire = InferOutput<typeof workRootSchema>;
export type WorkFactWire = InferOutput<typeof workFactSchema>;

export const parseWorkAttentionOutput = (value: unknown): WorkAttentionOutput =>
  parse(workAttentionOutputSchema, value);

export const workContract = {
  attention: oc
    .route({ method: 'POST', path: '/work/attention' })
    .input(workAttentionInputSchema)
    .output(workAttentionOutputSchema),
} as const;

export type WorkContractClient = ContractRouterClient<typeof workContract>;
