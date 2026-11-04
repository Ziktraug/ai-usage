import { type BoundedProcessRunner, runBoundedProcess } from '@ai-usage/local-machine/bounded-process';
import { isRecord } from '@ai-usage/report-core/datasets';
import { JIRA_ISSUE_KEY_PATTERN, WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import { httpStatusOf, JIRA_ISSUE_DEFAULTS, JIRA_NOT_INSTALLED_MESSAGE } from './jira-issues';

/** ASSUMED CLI shape, as for ADR 0054's view command; only synthetic fixtures validate this mapping. */
export const JIRA_DISCOVERY_JQL = 'assignee = currentUser() AND statusCategory != Done';
export type JiraIssueDiscoveryOutcome =
  | 'observed'
  | 'unavailable'
  | 'unauthenticated'
  | 'network'
  | 'not-found'
  | 'timeout'
  | 'invalid';
export interface DiscoverJiraIssuesOptions {
  readonly limit?: number;
  readonly maxOutputBytes?: number;
  readonly run?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface JiraIssueDiscoveryBatch {
  readonly keys: readonly string[];
  readonly outcome: JiraIssueDiscoveryOutcome;
  readonly outcomeMessage: string | null;
  readonly truncated: boolean;
}

/** Accept the assumed array or REST search envelope; every consumed key must be valid. */
export const parseJiraIssueSearch = (
  stdout: string,
): { readonly keys: readonly string[]; readonly total: number | null } | null => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const envelopeRows = isRecord(value) ? value.issues : undefined;
  const rows = Array.isArray(value) ? value : envelopeRows;
  if (!Array.isArray(rows)) {
    return null;
  }
  const reportedTotal = isRecord(value) ? value.total : undefined;
  if (
    reportedTotal !== undefined &&
    (typeof reportedTotal !== 'number' || !Number.isSafeInteger(reportedTotal) || reportedTotal < rows.length)
  ) {
    return null;
  }
  const keys: string[] = [];
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.key !== 'string' ||
      row.key.length > WORK_ATTENTION_BOUNDS.maxShortText ||
      !JIRA_ISSUE_KEY_PATTERN.test(row.key) ||
      Number(row.key.slice(row.key.lastIndexOf('-') + 1)) <= 0
    ) {
      return null;
    }
    keys.push(row.key);
  }
  return { keys, total: typeof reportedTotal === 'number' ? reportedTotal : null };
};

/** One bounded personal search. A missing CLI is unavailable, never a successful empty result. */
const searchJiraIssues = (
  jql: string,
  options: DiscoverJiraIssuesOptions = {},
): Effect.Effect<JiraIssueDiscoveryBatch> => {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit ?? 50))) : 50;
  const failed = (outcome: JiraIssueDiscoveryOutcome, outcomeMessage: string): JiraIssueDiscoveryBatch => ({
    keys: [],
    outcome,
    outcomeMessage,
    truncated: false,
  });
  return (options.run ?? runBoundedProcess)({
    args: ['jira', 'workitem', 'search', '--jql', jql, '--json', '--limit', String(limit)],
    command: 'acli',
    env: { CI: '1', NO_COLOR: '1', PAGER: 'cat' },
    maximumOutputBytes: options.maxOutputBytes ?? JIRA_ISSUE_DEFAULTS.maxOutputBytes,
    timeoutMs: options.timeoutMs ?? JIRA_ISSUE_DEFAULTS.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).pipe(
    Effect.map((result): JiraIssueDiscoveryBatch => {
      if (result.exitCode !== 0) {
        let status: number | null = null;
        try {
          status = httpStatusOf(JSON.parse(result.stdout));
        } catch {
          /* Never retain CLI stderr. */
        }
        let outcome: JiraIssueDiscoveryOutcome = status === 404 ? 'not-found' : 'network';
        if (status === 401 || status === 403) {
          outcome = 'unauthenticated';
        }
        return failed(outcome, `acli discovery ${outcome} (exit ${String(result.exitCode)})`);
      }
      const parsed = parseJiraIssueSearch(result.stdout);
      if (parsed === null) {
        return failed('invalid', 'acli returned an unexpected issue search shape');
      }
      return {
        keys: [...new Set(parsed.keys.slice(0, limit))],
        outcome: 'observed',
        outcomeMessage: null,
        truncated: parsed.keys.length >= limit || (parsed.total !== null && parsed.total > parsed.keys.length),
      };
    }),
    Effect.catch((error) =>
      Effect.succeed(
        failed(
          (
            {
              unavailable: 'unavailable',
              'timed-out': 'timeout',
              failed: 'invalid',
              'output-limit': 'invalid',
            } as const
          )[error.kind],
          error.kind === 'unavailable' ? JIRA_NOT_INSTALLED_MESSAGE : `acli discovery ${error.kind}`,
        ),
      ),
    ),
  );
};

/** Personal assignment discovery is independent of changes to already followed tickets. */
export const discoverJiraIssues = (options: DiscoverJiraIssuesOptions = {}) =>
  searchJiraIssues(JIRA_DISCOVERY_JQL, options);

/** Keep chunks below the search ceiling so a complete chunk never looks truncated. */
export const JIRA_CHANGE_SEARCH_KEYS = 40;
export const discoverChangedJiraIssues = (
  options: DiscoverJiraIssuesOptions & {
    readonly keys: readonly string[];
    readonly since: string | null;
    readonly now: Date;
  },
): Effect.Effect<JiraIssueDiscoveryBatch> => {
  const invalid: JiraIssueDiscoveryBatch = {
    keys: [],
    outcome: 'invalid',
    outcomeMessage: 'Jira change search scope or response is invalid',
    truncated: false,
  };
  if (
    options.keys.length > JIRA_CHANGE_SEARCH_KEYS ||
    options.keys.some((key) => !JIRA_ISSUE_KEY_PATTERN.test(key) || Number(key.split('-').at(-1)) <= 0) ||
    !Number.isFinite(options.now.getTime()) ||
    (options.since !== null && !Number.isFinite(Date.parse(options.since)))
  ) {
    return Effect.succeed(invalid);
  }
  if (options.keys.length === 0) {
    return Effect.succeed({ keys: [], outcome: 'observed', outcomeMessage: null, truncated: false });
  }
  // Relative minutes avoid Jira account/server timezone ambiguity. Overlap covers rounding and indexing delay;
  // the periodic full read is the recovery path for changes indexed beyond that overlap.
  const minutes =
    options.since === null
      ? null
      : Math.max(2, Math.ceil((options.now.getTime() - Date.parse(options.since)) / 60_000) + 2);
  const jql = `key IN (${options.keys.join(',')})${minutes === null ? '' : ` AND updated >= "-${minutes}m"`} ORDER BY updated ASC`;
  return searchJiraIssues(jql, { ...options, limit: 50 }).pipe(
    Effect.map((result) => (result.keys.some((key) => !options.keys.includes(key)) ? invalid : result)),
  );
};
