import { type CanonicalInstant, isCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  parseCheckoutStatusObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import {
  isWorkThreadId,
  parseWorkThread,
  parseWorkThreadCommand,
  parseWorkThreadEvent,
  parseWorkThreadLink,
  WORK_THREAD_BOUNDS,
  WORK_THREAD_COMMAND_FAILURES,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
} from '@ai-usage/report-core/work-thread';
import {
  WORK_THREAD_FACT_EVENT_KINDS,
  WORK_THREAD_SOURCE_STATES,
  WORK_THREAD_TABS,
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadEpisode,
  type WorkThreadListQuery,
} from '@ai-usage/report-core/work-thread-view';
import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  boolean,
  custom,
  finite,
  type InferOutput,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  parse,
  picklist,
  pipe,
  safeInteger,
  safeParse,
  strictObject,
  string,
  transform,
  variant,
} from 'valibot';
import { isJsonWireValue, publicMessageSchema } from './schema-conventions';

/** Frozen domain parsers remain the authority; normalize their accepted wire values once. */
const frozenSchema = <T>(parser: (value: unknown) => T | null) =>
  pipe(
    custom<T>((value) => parser(value) !== null, 'Invalid Work thread value.'),
    transform((value) => {
      const result = parser(value);
      if (result === null) {
        throw new Error('Invalid Work thread value.');
      }
      return result;
    }),
  );
const instant = custom<CanonicalInstant>(isCanonicalInstant, 'Expected a canonical ISO timestamp.');
const id = custom<string>(isWorkThreadId, 'Expected a UUID.');
const text = pipe(string(), minLength(1), maxLength(WORK_THREAD_BOUNDS.maxKey));
const count = pipe(number(), safeInteger(), minValue(0));
// Stored session durations may be fractional milliseconds; reads only widen (ADR 0075).
const duration = pipe(number(), finite(), minValue(0));
const revision = pipe(number(), safeInteger(), minValue(1));
const thread = frozenSchema(parseWorkThread);
const link = frozenSchema(parseWorkThreadLink);
const event = frozenSchema(parseWorkThreadEvent);
const source = strictObject({
  lastRunAt: nullable(instant),
  message: nullable(publicMessageSchema),
  source: picklist(['checkouts', 'github', 'jira', 'sessions']),
  state: picklist(WORK_THREAD_SOURCE_STATES),
});
const checkout = frozenSchema(parseCheckoutStatusObservation);
const pr = frozenSchema(parsePullRequestObservation);
const jira = frozenSchema(parseJiraIssueObservation);
const markers = strictObject({
  local: pipe(
    array(
      strictObject({
        key: text,
        latest: nullable(checkout),
        latestSuccessful: nullable(checkout),
        via: picklist(['branch-link', 'session-checkout']),
      }),
    ),
    maxLength(WORK_THREAD_BOUNDS.maxLinksPerThread),
  ),
  pullRequests: pipe(
    array(
      strictObject({
        key: text,
        latest: nullable(pr),
        latestSuccessful: nullable(pr),
        mergeable: nullable(picklist(['mergeable', 'conflicting', 'unknown'])),
        mergeStateStatus: nullable(text),
        role: nullable(picklist(['author', 'review-requested'])),
      }),
    ),
    maxLength(WORK_THREAD_BOUNDS.maxLinksPerThread),
  ),
  jiraIssues: pipe(
    array(strictObject({ key: text, latest: nullable(jira), latestSuccessful: nullable(jira) })),
    maxLength(WORK_THREAD_BOUNDS.maxLinksPerThread),
  ),
});
export const workThreadRowSchema = strictObject({
  afterDone: nullable(strictObject({ count, latestAt: instant })),
  delegatedSessionCount: count,
  firstActivityAt: instant,
  lastActivityAt: instant,
  links: pipe(array(link), maxLength(WORK_THREAD_BOUNDS.maxLinksPerThread)),
  markers,
  marks: pipe(
    array(
      strictObject({
        at: instant,
        harness: nullable(text),
        kind: picklist(['session', 'event']),
        label: nullable(pipe(string(), minLength(1), maxLength(WORK_THREAD_VIEW_BOUNDS.maxEpisodeText))),
      }),
    ),
    maxLength(WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow),
  ),
  runningSessions: count,
  sessionCount: count,
  thread,
});
export const workThreadsListInputSchema = strictObject({
  cursor: nullable(pipe(string(), minLength(1), maxLength(4096))),
  limit: pipe(number(), safeInteger(), minValue(1), maxValue(WORK_THREAD_VIEW_BOUNDS.maxPageSize)),
  project: nullable(pipe(string(), minLength(1), maxLength(WORK_THREAD_BOUNDS.maxTitle))),
  search: nullable(pipe(string(), maxLength(WORK_THREAD_VIEW_BOUNDS.maxSearch))),
  tab: picklist(WORK_THREAD_TABS),
});
export const workThreadsDetailInputSchema = strictObject({ threadId: id });
export const workThreadsListDataSchema = strictObject({
  counts: strictObject({ done: count, open: count }),
  generatedAt: instant,
  machineId: text,
  nextCursor: nullable(pipe(string(), minLength(1), maxLength(4096))),
  projects: pipe(array(text), maxLength(WORK_THREAD_VIEW_BOUNDS.maxProjects)),
  rows: pipe(array(workThreadRowSchema), maxLength(WORK_THREAD_VIEW_BOUNDS.maxPageSize)),
  sources: pipe(array(source), maxLength(4)),
});
const episodeText = nullable(pipe(string(), maxLength(WORK_THREAD_VIEW_BOUNDS.maxEpisodeText)));
const episodeFields = {
  activeMs: nullable(duration),
  endedAt: nullable(instant),
  firstPrompt: episodeText,
  harness: text,
  lastInstruction: episodeText,
  launchedBy: nullable(strictObject({ harness: text, title: episodeText })),
  linkKey: text,
  machineId: text,
  origin: nullable(picklist(['human', 'delegated', 'automated-review'])),
  projectLabel: nullable(text),
  question: episodeText,
  result: episodeText,
  resume: variant('kind', [
    strictObject({
      kind: literal('cli-resume'),
      command: pipe(string(), minLength(1), maxLength(4096)),
      cwd: nullable(pipe(string(), minLength(1), maxLength(4096))),
    }),
    strictObject({ kind: literal('none'), reason: publicMessageSchema }),
  ]),
  running: nullable(boolean()),
  sourceSessionId: text,
  spanMs: nullable(duration),
  startedAt: instant,
  title: episodeText,
} as const;
// Validate nested delegations iteratively, bounded independently of JavaScript stack depth.
const episodeFieldsSchema = strictObject(episodeFields);
export const workThreadEpisodeSchema = custom<WorkThreadEpisode>((value) => {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (
      ++visited > WORK_THREAD_VIEW_BOUNDS.maxEpisodes ||
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item)
    ) {
      return false;
    }
    const { children, ...fields } = item as Record<string, unknown>;
    if (
      !Array.isArray(children) ||
      children.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren ||
      !safeParse(episodeFieldsSchema, fields).success
    ) {
      return false;
    }
    pending.push(...children);
  }
  return true;
}, 'Invalid task session episode.');
export const workThreadsDetailDataSchema = strictObject({
  detachedLinks: pipe(array(link), maxLength(WORK_THREAD_BOUNDS.maxLinksPerThread)),
  episodes: pipe(array(workThreadEpisodeSchema), maxLength(WORK_THREAD_VIEW_BOUNDS.maxEpisodes)),
  events: pipe(array(event), maxLength(WORK_THREAD_BOUNDS.maxEventsPerThread)),
  factEvents: pipe(
    array(
      strictObject({
        at: instant,
        key: text,
        kind: picklist(WORK_THREAD_FACT_EVENT_KINDS),
        label: text,
        title: nullable(pipe(string(), maxLength(WORK_THREAD_VIEW_BOUNDS.maxEpisodeText))),
      }),
    ),
    maxLength(WORK_THREAD_VIEW_BOUNDS.maxFactEvents),
  ),
  generatedAt: instant,
  row: workThreadRowSchema,
  sources: pipe(array(source), maxLength(4)),
});
const readError = strictObject({
  ok: literal(false),
  error: strictObject({ tag: picklist(['Unavailable', 'NotFound']), message: publicMessageSchema }),
});
export const workThreadsListOutputSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON value.'),
  variant('ok', [strictObject({ ok: literal(true), data: workThreadsListDataSchema }), readError]),
);
export const workThreadsDetailOutputSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON value.'),
  variant('ok', [strictObject({ ok: literal(true), data: workThreadsDetailDataSchema }), readError]),
);
export const workThreadsCommandInputSchema = frozenSchema(parseWorkThreadCommand);
export const workThreadsCommandOutputSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON value.'),
  variant('ok', [
    strictObject({ ok: literal(true), applied: boolean(), followRevision: revision, threadId: id }),
    strictObject({
      ok: literal(false),
      currentRevision: nullable(revision),
      failure: picklist(WORK_THREAD_COMMAND_FAILURES),
      message: publicMessageSchema,
    }),
  ]),
);
export type WorkThreadsListInput = WorkThreadListQuery;
export type WorkThreadsDetailInput = InferOutput<typeof workThreadsDetailInputSchema>;
export type WorkThreadsListOutput = InferOutput<typeof workThreadsListOutputSchema>;
export type WorkThreadsDetailOutput = InferOutput<typeof workThreadsDetailOutputSchema>;
export type WorkThreadsCommandInput = WorkThreadCommand;
export type WorkThreadsCommandOutput = WorkThreadCommandResult;
export const parseWorkThreadsListOutput = (value: unknown): WorkThreadsListOutput =>
  parse(workThreadsListOutputSchema, value);
export const parseWorkThreadsDetailOutput = (value: unknown): WorkThreadsDetailOutput =>
  parse(workThreadsDetailOutputSchema, value);
export const parseWorkThreadsCommandOutput = (value: unknown): WorkThreadsCommandOutput =>
  parse(workThreadsCommandOutputSchema, value);
export const workThreadsContract = {
  list: oc
    .route({ method: 'POST', path: '/work/threads' })
    .input(workThreadsListInputSchema)
    .output(workThreadsListOutputSchema),
  detail: oc
    .route({ method: 'POST', path: '/work/threads/detail' })
    .input(workThreadsDetailInputSchema)
    .output(workThreadsDetailOutputSchema),
  command: oc
    .route({ method: 'POST', path: '/work/threads/command' })
    .errors({ Unavailable: { status: 503, message: 'The task command could not be recorded.' } })
    .input(workThreadsCommandInputSchema)
    .output(workThreadsCommandOutputSchema),
} as const;
export type WorkThreadsContractClient = ContractRouterClient<typeof workThreadsContract>;
