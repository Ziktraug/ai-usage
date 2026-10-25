import {
  type BoundedProcessError,
  type BoundedProcessOptions,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { type CanonicalInstant, canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  JIRA_ISSUE_KEY_PATTERN,
  type JiraIssueComment,
  type JiraIssueObservation,
  type JiraIssueObservationOutcome,
  type JiraStatusCategory,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';

/**
 * External fact (ADR 0054): what Jira shows for one explicitly linked issue at one instant, read
 * through the operator's own Atlassian CLI session. The engine holds no Jira credential: it never
 * reads, stores or forwards a token, and the bounded runner hands `acli` only the allow-listed
 * environment (PATH, HOME, locale, XDG_*), which is where the CLI keeps its own sign-in.
 *
 * ASSUMPTION — command shape assumed from the Atlassian CLI documentation, not exercised on this
 * machine: `acli jira workitem view <KEY> --json`. The JSON mapping below is tolerant on purpose
 * (unknown keys are ignored, the REST-style `fields` nesting and a flat shape are both accepted)
 * and strict on the types it uses, so a different real shape yields `invalid` observations, never
 * a wrong fact.
 *
 * `acli` writes its diagnostics to stderr, which the runner discards; failures are classified
 * from the exit code and stdout alone: a non-zero exit whose stdout is a JSON error body with an
 * HTTP 401 or 403 is `unauthenticated`, 404 is `not-found`, anything else is `network`; an
 * unreadable success body is `invalid`; a missing binary is `disabled`.
 */

export const JIRA_ISSUE_DEFAULTS = { maxKeys: 20, maxOutputBytes: 512 * 1024, timeoutMs: 10_000 } as const;
export const JIRA_NOT_INSTALLED_MESSAGE = 'acli not installed';
export const JIRA_SIGN_IN_ACTION = 'sign in to Jira (acli jira auth login)';
/** Assumed from the documentation; see the module note. */
export const JIRA_VIEW_COMMAND = ['jira', 'workitem', 'view'] as const;

export interface ObserveJiraIssuesOptions {
  readonly keys: readonly string[];
  readonly machineId: string;
  readonly maxKeys?: number;
  readonly maxOutputBytes?: number;
  readonly now: () => Date;
  readonly run?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface JiraIssueObservationBatch {
  readonly observations: readonly JiraIssueObservation[];
  /** Keys that are not issue keys, or the `<PROJECT>-0` placeholder. */
  readonly rejected: number;
  readonly truncated: boolean;
}

/** Forced for every `acli` call: no colour, no pager, no interactive prompt. */
const ACLI_ENVIRONMENT: Readonly<Record<string, string>> = {
  CI: '1',
  NO_COLOR: '1',
  PAGER: 'cat',
};

const { maxDetailText, maxJiraAuthorLabel, maxJiraCommentExcerpt, maxJiraComments, maxShortText } =
  WORK_ATTENTION_BOUNDS;
const ADF_MAX_NODES = 2000;
const ADF_MAX_DEPTH = 20;
const WHITESPACE = /\s+/g;
const COLONLESS_OFFSET = /([+-]\d{2})(\d{2})$/;
const HTTP_STATUS_TEXT = /^\d{3}$/;

/** Newest first; equal instants keep their order. */
const newestFirst = (left: JiraIssueComment, right: JiraIssueComment): number => {
  if (left.createdAt === right.createdAt) {
    return 0;
  }
  return left.createdAt < right.createdAt ? 1 : -1;
};

/** A status as a number, or a three-digit string; anything else is no status. */
const httpStatusValue = (raw: unknown): number | null => {
  if (typeof raw === 'number') {
    return raw;
  }
  return typeof raw === 'string' && HTTP_STATUS_TEXT.test(raw) ? Number(raw) : null;
};

const normalizeKey = (key: string): string | null => {
  const trimmed = typeof key === 'string' ? key.trim().toUpperCase() : '';
  if (!JIRA_ISSUE_KEY_PATTERN.test(trimmed) || Number(trimmed.slice(trimmed.lastIndexOf('-') + 1)) === 0) {
    return null;
  }
  return trimmed;
};

const failedObservation = (
  context: { readonly machineId: string; readonly observedAt: CanonicalInstant },
  key: string,
  outcome: Exclude<JiraIssueObservationOutcome, 'observed'>,
  outcomeMessage: string,
): JiraIssueObservation => ({
  assigneeLabel: null,
  commentCount: null,
  comments: [],
  key,
  machineId: context.machineId,
  observedAt: context.observedAt,
  outcome,
  outcomeMessage: outcomeMessage.slice(0, maxDetailText),
  parentKey: null,
  sprint: null,
  status: null,
  statusCategory: null,
  summary: null,
  updatedAt: null,
});

/** Jira writes offsets without a colon (`+0200`), which `Date` does not read reliably. */
const jiraInstant = (value: unknown): CanonicalInstant | null | undefined => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return;
  }
  return normalizeIsoTimestamp(value.replace(COLONLESS_OFFSET, '$1:$2')) ?? undefined;
};

/**
 * A person as the store may keep it: a display label, never an address. An address keeps only
 * its local part; nothing usable becomes `someone`.
 */
export const personLabel = (value: unknown): string => {
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  } else if (isRecord(value)) {
    for (const field of ['displayName', 'name', 'emailAddress']) {
      if (typeof value[field] === 'string') {
        raw = value[field];
        break;
      }
    }
  }
  let label = raw.trim();
  const at = label.indexOf('@');
  if (at >= 0) {
    label = label.slice(0, at).trim();
  }
  label = label.slice(0, maxJiraAuthorLabel).trim();
  return label.length === 0 ? 'someone' : label;
};

/** A text node's own text, or a mention's label; other nodes carry none of their own. */
const adfNodeText = (node: Record<string, unknown>): string | null => {
  if (typeof node.text === 'string') {
    return node.text;
  }
  return isRecord(node.attrs) && typeof node.attrs.text === 'string' ? node.attrs.text : null;
};

/** The plain text of an Atlassian Document Format body, bounded in nodes, depth and length. */
const adfText = (node: unknown): string => {
  const parts: string[] = [];
  let visited = 0;
  let length = 0;
  const visit = (value: unknown, depth: number): void => {
    if (visited >= ADF_MAX_NODES || depth > ADF_MAX_DEPTH || length >= maxJiraCommentExcerpt) {
      return;
    }
    visited += 1;
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const text = adfNodeText(value);
    if (text !== null) {
      parts.push(text);
      length += text.length + 1;
    }
    visit(value.content, depth + 1);
  };
  visit(node, 0);
  return parts.join(' ');
};

const excerptOf = (body: unknown): string => {
  const raw = typeof body === 'string' ? body : adfText(body);
  return raw.replace(WHITESPACE, ' ').trim().slice(0, maxJiraCommentExcerpt);
};

const STATUS_CATEGORY_BY_KEY: Readonly<Record<string, JiraStatusCategory>> = {
  done: 'done',
  indeterminate: 'in-progress',
  new: 'todo',
  undefined: 'unknown',
};
const STATUS_CATEGORY_BY_NAME: Readonly<Record<string, JiraStatusCategory>> = {
  done: 'done',
  'in progress': 'in-progress',
  'no category': 'unknown',
  'to do': 'todo',
};

const statusCategoryOf = (value: unknown): JiraStatusCategory => {
  if (!isRecord(value)) {
    return 'unknown';
  }
  if (typeof value.key === 'string' && value.key.toLowerCase() in STATUS_CATEGORY_BY_KEY) {
    return STATUS_CATEGORY_BY_KEY[value.key.toLowerCase()] ?? 'unknown';
  }
  if (typeof value.name === 'string' && value.name.toLowerCase() in STATUS_CATEGORY_BY_NAME) {
    return STATUS_CATEGORY_BY_NAME[value.name.toLowerCase()] ?? 'unknown';
  }
  return 'unknown';
};

interface ParsedStatus {
  readonly category: JiraStatusCategory | null;
  readonly name: string | null;
}

/** `status` as a REST object (`{ name, statusCategory }`) or a bare name; absent is no status. */
const parseStatus = (value: unknown): ParsedStatus | undefined => {
  if (value === null || value === undefined) {
    return { category: null, name: null };
  }
  if (typeof value === 'string') {
    return { category: 'unknown', name: value.slice(0, maxShortText) };
  }
  if (!(isRecord(value) && typeof value.name === 'string')) {
    return;
  }
  return { category: statusCategoryOf(value.statusCategory), name: value.name.slice(0, maxShortText) };
};

/** A sprint as a `{ name }` object, a list of them (the last is current), or a bare name; other shapes are "unknown", not invalid. */
const parseSprint = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value.slice(0, maxShortText);
  }
  const candidate = Array.isArray(value) ? value.at(-1) : value;
  return isRecord(candidate) && typeof candidate.name === 'string' ? candidate.name.slice(0, maxShortText) : null;
};

/** Jira's comment id as a string; a comment without one is named by its position. */
const commentId = (value: unknown, index: number): string => {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return typeof value === 'number' ? String(value) : `comment-${String(index)}`;
};

const parseComment = (value: unknown, index: number): JiraIssueComment | undefined => {
  if (!isRecord(value)) {
    return;
  }
  const createdAt = jiraInstant(value.created ?? value.createdAt);
  if (createdAt === null || createdAt === undefined) {
    return;
  }
  return {
    authorLabel: personLabel(value.author),
    createdAt,
    excerpt: excerptOf(value.body),
    id: commentId(value.id, index),
  };
};

interface ParsedComments {
  readonly comments: readonly JiraIssueComment[];
  readonly total: number | null;
}

/** `comment: { comments[], total }` (REST) or a bare `comments[]`; absent means no comment information. */
const parseComments = (fields: Record<string, unknown>): ParsedComments | undefined => {
  const container = fields.comment ?? fields.comments;
  if (container === null || container === undefined) {
    return { comments: [], total: null };
  }
  const entries = isRecord(container) ? container.comments : container;
  if (!Array.isArray(entries)) {
    return;
  }
  const comments: JiraIssueComment[] = [];
  for (const [index, entry] of entries.entries()) {
    const comment = parseComment(entry, index);
    if (comment === undefined) {
      return;
    }
    comments.push(comment);
  }
  const reportedTotal = isRecord(container) ? container.total : undefined;
  const total =
    typeof reportedTotal === 'number' && Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
      ? reportedTotal
      : comments.length;
  comments.sort(newestFirst);
  return { comments: comments.slice(0, maxJiraComments), total };
};

export interface ParsedJiraIssue {
  readonly assigneeLabel: string | null;
  readonly commentCount: number | null;
  readonly comments: readonly JiraIssueComment[];
  readonly parentKey: string | null;
  readonly sprint: string | null;
  readonly status: string | null;
  readonly statusCategory: JiraStatusCategory | null;
  readonly summary: string | null;
  readonly updatedAt: CanonicalInstant | null;
}

/**
 * Tolerant read of the assumed `acli jira workitem view --json` body: unknown keys are ignored,
 * the keys used must have the expected types, and a `key` that names another issue is refused.
 */
export const parseJiraIssueView = (stdout: string, key: string): ParsedJiraIssue | null => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.key !== undefined && !(typeof value.key === 'string' && value.key.trim().toUpperCase() === key)) {
    return null;
  }
  const fields = isRecord(value.fields) ? value.fields : value;
  const summary = fields.summary === null || fields.summary === undefined ? null : fields.summary;
  const status = parseStatus(fields.status);
  const updatedAt = jiraInstant(fields.updated ?? fields.updatedAt);
  const assignee = fields.assignee;
  const parent = isRecord(fields.parent) ? fields.parent.key : fields.parent;
  const comments = parseComments(fields);
  if (
    !(summary === null || typeof summary === 'string') ||
    status === undefined ||
    updatedAt === undefined ||
    !(assignee === null || assignee === undefined || typeof assignee === 'string' || isRecord(assignee)) ||
    !(parent === null || parent === undefined || typeof parent === 'string') ||
    comments === undefined
  ) {
    return null;
  }
  const parentKey = typeof parent === 'string' ? normalizeKey(parent) : null;
  return {
    assigneeLabel: assignee === null || assignee === undefined ? null : personLabel(assignee),
    commentCount: comments.total,
    comments: comments.comments,
    parentKey,
    sprint: parseSprint(fields.sprint),
    status: status.name,
    statusCategory: status.category,
    summary: summary === null ? null : summary.slice(0, maxShortText),
    updatedAt,
  };
};

type AcliRead =
  | { readonly kind: 'completed'; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'output-limit' }
  | { readonly kind: 'failed' };

interface RunContext {
  readonly base: Pick<BoundedProcessOptions, 'maximumOutputBytes' | 'signal' | 'timeoutMs'>;
  readonly machineId: string;
  readonly now: () => Date;
  readonly run: BoundedProcessRunner;
}

const acliReadFailure = (kind: BoundedProcessError['kind']): AcliRead => {
  switch (kind) {
    case 'timed-out':
      return { kind: 'timeout' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'output-limit':
      return { kind: 'output-limit' };
    default:
      return { kind: 'failed' };
  }
};

const acli = (context: RunContext, args: readonly string[]): Effect.Effect<AcliRead> =>
  context.run({ ...context.base, args, command: 'acli', env: ACLI_ENVIRONMENT }).pipe(
    Effect.map((result): AcliRead => ({ exitCode: result.exitCode, kind: 'completed', stdout: result.stdout })),
    Effect.catch((error) => Effect.succeed<AcliRead>(acliReadFailure(error.kind))),
  );

interface Classification {
  /** Whether later keys in this run should be skipped with the same outcome. */
  readonly haltsRun: boolean;
  readonly message: string;
  readonly outcome: Exclude<JiraIssueObservationOutcome, 'observed'>;
}

const HTTP_STATUS_FIELDS = ['status', 'statusCode', 'httpStatus', 'code'];

/** An HTTP status in an error body: a number or numeric string at the top level or under `error` / `response`. */
export const httpStatusOf = (value: unknown): number | null => {
  const candidates = isRecord(value) ? [value, value.error, value.response] : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const field of HTTP_STATUS_FIELDS) {
      const status = httpStatusValue(candidate[field]);
      if (status !== null && status >= 100 && status <= 599) {
        return status;
      }
    }
  }
  return null;
};

const classifyFailure = (exitCode: number, stdout: string): Classification => {
  const body = stdout.trim();
  if (body.length === 0) {
    return {
      haltsRun: true,
      message: `acli exited ${String(exitCode)} without output (network failure or not signed in)`,
      outcome: 'network',
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { haltsRun: false, message: `acli exited ${String(exitCode)} with an unreadable body`, outcome: 'invalid' };
  }
  const status = httpStatusOf(value);
  if (status === 401 || status === 403) {
    return {
      haltsRun: true,
      message: `Jira rejected the credentials (HTTP ${String(status)}); ${JIRA_SIGN_IN_ACTION}`,
      outcome: 'unauthenticated',
    };
  }
  if (status === 404) {
    return {
      haltsRun: false,
      message: 'Jira returned HTTP 404 (not found or not visible to this account)',
      outcome: 'not-found',
    };
  }
  return {
    haltsRun: false,
    message:
      status === null
        ? `acli exited ${String(exitCode)} with an error body without an HTTP status`
        : `Jira returned HTTP ${String(status)}`,
    outcome: 'network',
  };
};

const observeKey = (
  context: RunContext,
  key: string,
): Effect.Effect<{ readonly observation: JiraIssueObservation; readonly halt: Classification | null }> =>
  Effect.gen(function* () {
    const observedAt = canonicalInstantFromDate(context.now());
    const failure = (classification: Classification) => ({
      halt: classification.haltsRun ? classification : null,
      observation: failedObservation(
        { machineId: context.machineId, observedAt },
        key,
        classification.outcome,
        classification.message,
      ),
    });
    const view = yield* acli(context, [...JIRA_VIEW_COMMAND, key, '--json']);
    if (view.kind === 'timeout') {
      return failure({ haltsRun: true, message: 'acli timed out', outcome: 'timeout' });
    }
    if (view.kind === 'unavailable') {
      return failure({ haltsRun: true, message: JIRA_NOT_INSTALLED_MESSAGE, outcome: 'disabled' });
    }
    if (view.kind === 'output-limit') {
      return failure({ haltsRun: false, message: 'acli output exceeded the size ceiling', outcome: 'invalid' });
    }
    if (view.kind === 'failed') {
      return failure({ haltsRun: false, message: 'acli output could not be read', outcome: 'invalid' });
    }
    if (view.exitCode !== 0) {
      return failure(classifyFailure(view.exitCode, view.stdout));
    }
    const parsed = parseJiraIssueView(view.stdout, key);
    if (parsed === null) {
      return failure({ haltsRun: false, message: 'acli returned an unexpected issue shape', outcome: 'invalid' });
    }
    return {
      halt: null,
      observation: {
        assigneeLabel: parsed.assigneeLabel,
        commentCount: parsed.commentCount,
        comments: parsed.comments,
        key,
        machineId: context.machineId,
        observedAt,
        outcome: 'observed',
        outcomeMessage: null,
        parentKey: parsed.parentKey,
        sprint: parsed.sprint,
        status: parsed.status,
        statusCategory: parsed.statusCategory,
        summary: parsed.summary,
        updatedAt: parsed.updatedAt,
      },
    };
  });

/**
 * Observes each distinct key once, in order, up to `maxKeys`. After a run-halting failure
 * (missing `acli`, timeout, no credentials, network silence) the remaining keys are recorded with
 * that outcome without another call, so an offline or signed-out machine costs one process spawn
 * per cycle. Never fails.
 */
export const observeJiraIssues = (options: ObserveJiraIssuesOptions): Effect.Effect<JiraIssueObservationBatch> =>
  Effect.gen(function* () {
    const maxKeys = options.maxKeys ?? JIRA_ISSUE_DEFAULTS.maxKeys;
    const unique: string[] = [];
    let rejected = 0;
    for (const candidate of options.keys) {
      const key = normalizeKey(candidate);
      if (key === null) {
        rejected += 1;
      } else if (!unique.includes(key)) {
        unique.push(key);
      }
    }
    const selected = unique.slice(0, maxKeys);
    const truncated = unique.length > selected.length;
    const context: RunContext = {
      base: {
        maximumOutputBytes: options.maxOutputBytes ?? JIRA_ISSUE_DEFAULTS.maxOutputBytes,
        timeoutMs: options.timeoutMs ?? JIRA_ISSUE_DEFAULTS.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      machineId: options.machineId,
      now: options.now,
      run: options.run ?? runBoundedProcess,
    };
    const observations: JiraIssueObservation[] = [];
    let halt: Classification | null = null;
    for (const key of selected) {
      if (halt !== null) {
        observations.push(
          failedObservation(
            { machineId: options.machineId, observedAt: canonicalInstantFromDate(options.now()) },
            key,
            halt.outcome,
            `not attempted: ${halt.message}`,
          ),
        );
        continue;
      }
      const result = yield* observeKey(context, key);
      observations.push(result.observation);
      halt = result.halt;
    }
    return { observations, rejected, truncated };
  });
