import { createHash, randomUUID } from 'node:crypto';
import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type JiraIssueObservation,
  type PullRequestObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import { jiraKeysInBranch } from '@ai-usage/report-core/work-attention-facts';
import {
  isBranchRefName,
  isWorkThreadId,
  jiraIssueLinkKey,
  parseWorkThread,
  parseWorkThreadCommand,
  parseWorkThreadEvent,
  parseWorkThreadLink,
  parseWorkThreadLinkKey,
  SHARED_BRANCH_NAMES,
  WORK_THREAD_BOUNDS,
  WORK_THREAD_COMMAND_FAILURES,
  type WorkIntakeCommandResult,
  type WorkThread,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
  type WorkThreadEvent,
  type WorkThreadIntent,
  type WorkThreadLink,
  type WorkThreadLinkKind,
  type WorkThreadTaskCommand,
  type WorkThreadWait,
} from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_VIEW_BOUNDS, type WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import { MAX_WORK_DELEGATIONS_JSON, readWorkSessionDelegations } from './work-session-join';

/** Operator-owned state, outside served revisions, collection generations and the outbox. */
export const WORK_THREAD_TABLES = [
  'work_threads',
  'work_thread_links',
  'work_thread_events',
  'work_thread_commands',
  'work_jira_intake',
  'work_thread_combinations',
  'work_session_branches',
  'work_session_branch_builds',
  'work_branch_reconciliation',
] as const;

export const workThreadSchemaSql = `
  CREATE TABLE IF NOT EXISTS work_threads (
    thread_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT,
    project_label TEXT,
    intent TEXT CHECK (intent IS NULL OR intent IN ('analysis', 'change', 'review')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'pull-request', 'jira-issue', 'session')),
    origin_key TEXT UNIQUE,
    follow_state TEXT NOT NULL CHECK (follow_state IN ('following', 'waiting', 'done')),
    follow_revision INTEGER NOT NULL CHECK (follow_revision >= 1),
    waiting_for TEXT,
    waiting_on_json TEXT,
    done_at TEXT,
    done_reason TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    CHECK ((origin = 'user') = (origin_key IS NULL)),
    CHECK ((follow_state = 'done') = (done_at IS NOT NULL)),
    CHECK (follow_state = 'done' OR done_reason IS NULL),
    CHECK (follow_state = 'waiting' OR (waiting_for IS NULL AND waiting_on_json IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_work_threads_activity ON work_threads(last_activity_at DESC, thread_id);
  CREATE INDEX IF NOT EXISTS idx_work_threads_scope
    ON work_threads(follow_state, project_label, last_activity_at DESC, thread_id);
  CREATE TABLE IF NOT EXISTS work_thread_links (
    link_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    kind TEXT NOT NULL CHECK (kind IN ('pull-request', 'jira-issue', 'session', 'branch')),
    link_key TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('user', 'origin', 'declared', 'launched')),
    created_at TEXT NOT NULL,
    detached_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_thread_active_link
    ON work_thread_links(thread_id, kind, link_key) WHERE detached_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_work_thread_link_history ON work_thread_links(thread_id, detached_at DESC);
  CREATE TABLE IF NOT EXISTS work_thread_events (
    event_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    at TEXT NOT NULL,
    event_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_thread_events ON work_thread_events(thread_id, at DESC);
  CREATE TABLE IF NOT EXISTS work_thread_commands (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_thread_combinations (
    combination_id INTEGER PRIMARY KEY,
    member_thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    kept_thread_id TEXT NOT NULL REFERENCES work_threads(thread_id),
    ticket_key TEXT NOT NULL,
    combined_at TEXT NOT NULL,
    combine_command_id TEXT NOT NULL,
    separated_at TEXT,
    separate_command_id TEXT,
    CHECK (member_thread_id != kept_thread_id),
    CHECK ((separated_at IS NULL) = (separate_command_id IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_thread_combinations_active
    ON work_thread_combinations(member_thread_id) WHERE separated_at IS NULL;
  CREATE TABLE IF NOT EXISTS work_jira_intake (
    machine_id TEXT NOT NULL,
    link_key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    assigned INTEGER NOT NULL CHECK (assigned IN (0, 1)),
    assigned_at TEXT NOT NULL,
    dismissed_at TEXT,
    PRIMARY KEY (machine_id, link_key)
  );
  -- Branch evidence (ADR 0081): which sessions recorded which repository branch, rebuilt by the
  -- engine from the served revision. Derived and disposable; tasks hold the branch links.
  CREATE TABLE IF NOT EXISTS work_session_branches (
    revision TEXT NOT NULL,
    link_key TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('interactive', 'exec', 'delegated', 'review', 'unknown')),
    repository_label TEXT NOT NULL,
    started_at TEXT,
    title TEXT,
    source_path TEXT,
    PRIMARY KEY (revision, link_key, machine_id, harness, session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_work_session_branches_key
    ON work_session_branches(link_key, machine_id, role, started_at);
  CREATE TABLE IF NOT EXISTS work_session_branch_builds (
    revision TEXT PRIMARY KEY,
    built_at TEXT NOT NULL,
    aliases_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_branch_reconciliation (
    machine_id TEXT PRIMARY KEY,
    creation_cutoff_at TEXT NOT NULL
  );
`;

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
  };
}

interface WorkThreadStoreDependencies {
  readonly usageStoreError: (
    operation: string,
    dbPath: string,
    cause: unknown,
    reason: UsageStoreErrorReason,
  ) => UsageStoreError;
  readonly usageStoreReadError: (operation: string, dbPath: string, cause: unknown) => UsageStoreError;
  readonly withUsageStoreReader: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
  readonly withUsageStoreWriter: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
}

export interface ApplyWorkThreadCommandInput {
  readonly command: WorkThreadCommand;
  readonly dbPath: string;
  readonly machineId: string;
  readonly now: string;
}

export interface WorkThreadSeed {
  /** The PR's head branch key, when in its own repository: joins the task holding it (ADR 0081). */
  readonly branchKey?: string | null;
  readonly discoveredAt: string;
  readonly intent: WorkThreadIntent | null;
  readonly linkKind: WorkThreadLinkKind;
  readonly origin: 'pull-request' | 'jira-issue' | 'session';
  readonly originKey: string;
  readonly projectLabel: string | null;
  /** `jira:<site>/<KEY>` an authored PR's head branch names; routes the PR to that ticket's task. */
  readonly routingJiraKey?: string | null;
  readonly title: string;
}

export interface SeedWorkThreadsInput {
  readonly dbPath: string;
  readonly declarations?: readonly DeclaredWorkThreadSession[];
  /** Incomplete discovery cannot establish a unique candidate. */
  readonly declarationsTruncated?: boolean;
  readonly machineId: string;
  readonly now: string;
  /** Successfully observed links may enrich a candidate even without author/review discovery. */
  readonly observedPullRequestKeys?: readonly string[];
  readonly seeds: readonly WorkThreadSeed[];
}

export interface SeedWorkThreadsResult {
  readonly created: number;
  readonly existing: number;
  readonly uncertain: number;
}

export interface DeclaredWorkThreadSession {
  readonly provenance?: 'session-pr-link';
  readonly pullRequestKey: string;
  readonly sessionKey: string;
}

export interface AttachDeclaredWorkThreadSessionsInput {
  readonly dbPath: string;
  readonly declarations: readonly DeclaredWorkThreadSession[];
  readonly machineId: string;
  readonly now: string;
}

export interface AttachDeclaredWorkThreadSessionsResult {
  readonly detached: number;
  readonly existing: number;
  readonly linked: number;
  readonly truncated: boolean;
}

const MAX_DECLARED_SESSION_LINKS = 500;

const MAX_WAIT_CANDIDATES = 500;
interface WorkThreadWaitFact {
  readonly mergedAt: CanonicalInstant | null;
  readonly observedAt: CanonicalInstant;
  readonly state: string | null;
  readonly updatedAt: CanonicalInstant | null;
  readonly value: string | null;
}

/** Captured before a provider read; the writer rechecks this revision and active link. */
export interface WorkThreadWaitCandidate {
  readonly followRevision: number;
  readonly history: readonly WorkThreadWaitFact[];
  readonly linkId: string;
  readonly threadId: string;
  readonly waitingOn: WorkThreadWait;
}

export interface QueryWorkThreadWaitCandidatesInput {
  readonly dbPath: string;
  readonly kind: WorkThreadWait['kind'];
  readonly linkKeys: readonly string[];
  readonly machineId: string;
}

export interface QueryWorkThreadWaitCandidatesResult {
  readonly candidates: readonly WorkThreadWaitCandidate[];
  readonly truncated: boolean;
}

export interface ApplyWorkThreadWaitObservationsInput {
  readonly candidates: readonly WorkThreadWaitCandidate[];
  readonly dbPath: string;
  readonly jiraIssues?: readonly JiraIssueObservation[];
  readonly machineId: string;
  readonly now: string;
  readonly pullRequests?: readonly PullRequestObservation[];
}

export interface ApplyWorkThreadWaitObservationsResult {
  readonly satisfied: number;
  readonly unchanged: number;
  /** New source updates whose retained history cannot establish a change after the wait. */
  readonly unproven: number;
}

export interface RecordJiraIntakeInput {
  /** Only a complete search proves that an issue absent from it is no longer assigned. */
  readonly complete: boolean;
  readonly dbPath: string;
  /** Issue keys (`XLB-1`) the assigned-issue search returned this run. */
  readonly keys: readonly string[];
  readonly machineId: string;
  readonly now: string;
}

export interface QueryJiraIntakeInput {
  readonly dbPath: string;
  readonly limit: number;
  readonly machineId: string;
}

export interface JiraIntakeEntry {
  readonly firstSeenAt: CanonicalInstant;
  /** `jira:<site>/<KEY>` */
  readonly key: string;
}

export interface QueryJiraIntakeResult {
  readonly items: readonly JiraIntakeEntry[];
  readonly truncated: boolean;
}

const MAX_JIRA_INTAKE_KEYS = 500;

export interface WorkThreadCombination {
  readonly keptThreadId: string;
  readonly keptTitle: string;
  readonly memberThreadId: string;
  readonly memberTitle: string;
  readonly ticketKey: string;
}

export interface WorkThreadCombineSuggestionEntry {
  readonly blockers: readonly string[];
  readonly keptThreadId: string;
  readonly participants: readonly {
    readonly pullRequestKeys: readonly string[];
    readonly sessionCount: number;
    readonly thread: WorkThread;
  }[];
  readonly ticketKey: string;
}

export interface QueryWorkThreadCombineSuggestionsResult {
  readonly items: readonly WorkThreadCombineSuggestionEntry[];
  readonly truncated: boolean;
}

export interface QueryWorkThreadsPageInput {
  readonly dbPath: string;
  readonly query: WorkThreadListQuery;
}

export interface WorkThreadPageRow {
  readonly lastActivityAt: CanonicalInstant;
  readonly thread: WorkThread;
}

export interface QueryWorkThreadsPageResult {
  readonly nextCursor: string | null;
  readonly rows: readonly WorkThreadPageRow[];
}

export interface QueryWorkThreadByIdInput {
  readonly dbPath: string;
  readonly threadId: string;
}

export interface QueryWorkThreadLinksInput {
  readonly dbPath: string;
  readonly threadIds: readonly string[];
}

export interface QueryActiveWorkThreadLinksInput {
  readonly dbPath: string;
  /**
   * Apply terminal-state eligibility before the bound; a failure after a merge, or a merged read
   * without its status history, stays eligible.
   */
  readonly excludeObservedMerged?: boolean;
  /** Restrict Jira authority before the bound; omitted means all sites. */
  readonly jiraSite?: string;
  readonly kind: 'pull-request' | 'jira-issue';
  readonly limit: number;
  readonly machineId: string;
}

export interface QueryActiveWorkThreadLinksResult {
  readonly links: readonly WorkThreadLink[];
  readonly truncated: boolean;
}

/** Repository authorities are case-insensitive; Git branch refs remain case-sensitive. */
const canonicalLinkKey = (kind: WorkThreadLinkKind, key: string): string => {
  if (kind === 'pull-request') {
    return key.toLowerCase();
  }
  if (kind === 'branch') {
    const boundary = key.indexOf('@');
    return boundary < 0 ? key : key.slice(0, boundary).toLowerCase() + key.slice(boundary);
  }
  return key;
};

const comparableLinkSql = (kind: WorkThreadLinkKind): string => {
  if (kind === 'pull-request') {
    return 'lower(link_key)';
  }
  if (kind === 'branch') {
    return "lower(substr(link_key, 1, instr(link_key, '@') - 1)) || substr(link_key, instr(link_key, '@'))";
  }
  return 'link_key';
};

const normalizeCommandLink = (link: unknown): unknown =>
  isRecord(link) && typeof link.key === 'string' && (link.kind === 'pull-request' || link.kind === 'branch')
    ? { ...link, key: canonicalLinkKey(link.kind, link.key) }
    : link;

const invalidInput = (message: string): never => {
  throw new UsageStoreError({ message, operation: 'work-thread', reason: 'invalid-input' });
};

const instant = (value: string): CanonicalInstant =>
  normalizeIsoTimestamp(value) ?? invalidInput('Work thread timestamp must be an ISO instant');

const validated = <Value>(value: Value | null, label: string): Value => {
  if (value === null) {
    throw new UsageStoreError({
      message: `Invalid stored work thread ${label}`,
      operation: 'work-thread',
      reason: 'corrupt',
    });
  }
  return value;
};

const record = (value: unknown): Record<string, unknown> => validated(isRecord(value) ? value : null, 'record');
const json = (value: unknown): unknown => JSON.parse(validated(typeof value === 'string' ? value : null, 'JSON'));

const waitLinkKind = (kind: WorkThreadWait['kind']): 'pull-request' | 'jira-issue' =>
  kind === 'pull-request-review' ? 'pull-request' : 'jira-issue';

const storedWaitFacts = (
  db: SqliteDatabase,
  machineId: string,
  wait: WorkThreadWait,
  observedAt?: CanonicalInstant,
): readonly WorkThreadWaitFact[] => {
  const parsed = parseWorkThreadLinkKey(waitLinkKind(wait.kind), wait.linkKey);
  if (
    parsed === null ||
    (parsed.kind !== 'pull-request' && parsed.kind !== 'jira-issue') ||
    (parsed.kind === 'jira-issue' && parsed.site !== 'default')
  ) {
    return [];
  }
  const parameters: unknown[] =
    parsed.kind === 'pull-request'
      ? [machineId, parsed.host.toLowerCase(), parsed.repository.toLowerCase(), parsed.number]
      : [machineId, parsed.key];
  if (observedAt !== undefined) {
    parameters.push(observedAt);
  }
  const values = db
    .query(
      parsed.kind === 'pull-request'
        ? `SELECT observed_at, updated_at, merged_at, state, review_decision AS value
      FROM pull_request_observations WHERE machine_id = ? AND lower(host) = ? AND lower(repository) = ?
      AND number = ? AND outcome = 'observed' ${observedAt === undefined ? '' : 'AND observed_at = ?'}
      ORDER BY observed_at DESC, id DESC LIMIT 6`
        : `SELECT observed_at, updated_at, NULL AS merged_at, NULL AS state, status AS value
      FROM jira_issue_observations WHERE machine_id = ? AND issue_key = ? AND outcome = 'observed'
      ${observedAt === undefined ? '' : 'AND observed_at = ?'} ORDER BY observed_at DESC, id DESC LIMIT 6`,
    )
    .all(...parameters);
  return values.map((value) => {
    const row = record(value);
    const optionalDate = (date: unknown): CanonicalInstant | null =>
      date === null ? null : validated(normalizeIsoTimestamp(date), 'wait fact date');
    const optionalText = (text: unknown): string | null =>
      text === null ? null : validated(typeof text === 'string' ? text : null, 'wait fact text');
    return {
      observedAt: validated(normalizeIsoTimestamp(row.observed_at), 'wait fact observation date'),
      updatedAt: optionalDate(row.updated_at),
      mergedAt: optionalDate(row.merged_at),
      state: optionalText(row.state),
      value: optionalText(row.value),
    };
  });
};

const waitEvidence = (
  candidate: WorkThreadWaitCandidate,
  facts: readonly WorkThreadWaitFact[],
  now: CanonicalInstant,
): { readonly reason: string | null; readonly unproven: boolean } => {
  const wait = candidate.waitingOn;
  const known: WorkThreadWaitFact[] = [];
  let unproven = false;
  for (const fact of facts
    .filter((item) => item.observedAt <= now)
    .toSorted((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    if (wait.kind === 'pull-request-review' && fact.state === 'MERGED') {
      if (fact.mergedAt !== null && fact.mergedAt > wait.since && fact.mergedAt <= now) {
        return { reason: `Pull request MERGED at ${fact.mergedAt}`, unproven: false };
      }
      continue;
    }
    const qualifies = wait.kind === 'jira-update' || fact.value === 'APPROVED' || fact.value === 'CHANGES_REQUESTED';
    if (
      qualifies &&
      fact.value !== null &&
      (fact.updatedAt === null || (fact.updatedAt > wait.since && fact.updatedAt <= now))
    ) {
      // Provider observedAt is the start of its read. A source change during that read
      // may be later, so application time, not observedAt, is the upper bound.
      const previous = known.findLast(
        (item) =>
          item.observedAt >= wait.since &&
          item.observedAt < fact.observedAt &&
          item.value !== fact.value &&
          fact.updatedAt !== null &&
          item.observedAt <= fact.updatedAt,
      );
      if (previous !== undefined && fact.updatedAt !== null) {
        return {
          reason:
            wait.kind === 'pull-request-review'
              ? `Pull request review ${fact.value}; source updated at ${fact.updatedAt}; previous ${previous.value} observed at ${previous.observedAt}`
              : `Jira status ${previous.value?.slice(0, 96)} -> ${fact.value.slice(0, 96)}; source updated at ${fact.updatedAt}; previous observed at ${previous.observedAt}`,
          unproven: false,
        };
      }
      unproven = true;
    }
    if (
      fact.value !== null &&
      (wait.kind === 'jira-update' || ['REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED'].includes(fact.value))
    ) {
      known.push(fact);
    }
  }
  return { reason: null, unproven };
};

const threadFromRecord = (value: unknown): WorkThread => {
  const row = record(value);
  return validated(
    parseWorkThread({
      createdAt: row.created_at,
      doneAt: row.done_at,
      doneReason: row.done_reason,
      followRevision: row.follow_revision,
      followState: row.follow_state,
      intent: row.intent,
      machineId: row.machine_id,
      note: row.note,
      objective: row.objective,
      origin: row.origin,
      originKey:
        typeof row.origin_key === 'string' && row.origin === 'pull-request'
          ? row.origin_key.toLowerCase()
          : row.origin_key,
      projectLabel: 'effective_project' in row ? row.effective_project : row.project_label,
      threadId: row.thread_id,
      title: row.title,
      updatedAt: row.updated_at,
      waitingFor: row.waiting_for,
      waitingOn: row.waiting_on_json === null ? null : json(row.waiting_on_json),
    }),
    'row',
  );
};

const linkFromRecord = (value: unknown): WorkThreadLink => {
  const row = record(value);
  return validated(
    parseWorkThreadLink({
      createdAt: row.created_at,
      detachedAt: row.detached_at,
      key:
        typeof row.link_key === 'string' && (row.kind === 'branch' || row.kind === 'pull-request')
          ? canonicalLinkKey(row.kind, row.link_key)
          : row.link_key,
      kind: row.kind,
      linkId: row.link_id,
      provenance: row.provenance,
      threadId: row.thread_id,
    }),
    'link',
  );
};

const readThread = (db: SqliteDatabase, threadId: string): WorkThread | null => {
  const row = db.query('SELECT * FROM work_threads WHERE thread_id = ?').get(threadId);
  return row === null ? null : threadFromRecord(row);
};

const saveThread = (db: SqliteDatabase, thread: WorkThread): void => {
  validated(parseWorkThread(thread), 'write');
  db.query(`INSERT INTO work_threads (
    thread_id, machine_id, title, objective, project_label, intent, origin, origin_key,
    follow_state, follow_revision, waiting_for, waiting_on_json, done_at, done_reason,
    note, created_at, updated_at, last_activity_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(thread_id) DO UPDATE SET
    title = excluded.title, follow_state = excluded.follow_state, follow_revision = excluded.follow_revision,
    waiting_for = excluded.waiting_for, waiting_on_json = excluded.waiting_on_json,
    done_at = excluded.done_at, done_reason = excluded.done_reason, note = excluded.note,
    updated_at = excluded.updated_at, last_activity_at = MAX(work_threads.last_activity_at, excluded.last_activity_at)
  `).run(
    thread.threadId,
    thread.machineId,
    thread.title,
    thread.objective,
    thread.projectLabel,
    thread.intent,
    thread.origin,
    thread.originKey,
    thread.followState,
    thread.followRevision,
    thread.waitingFor,
    thread.waitingOn === null ? null : JSON.stringify(thread.waitingOn),
    thread.doneAt,
    thread.doneReason,
    thread.note,
    thread.createdAt,
    thread.updatedAt,
    thread.updatedAt,
  );
};

const addEvent = (
  db: SqliteDatabase,
  thread: WorkThread,
  at: CanonicalInstant,
  kind: WorkThreadEvent['kind'],
  details: Partial<
    Pick<WorkThreadEvent, 'acknowledgedRemainders' | 'fromState' | 'toState' | 'linkKey' | 'reason'>
  > = {},
): void => {
  const event = validated(
    parseWorkThreadEvent({
      acknowledgedRemainders: [],
      at,
      eventId: randomUUID(),
      fromState: null,
      kind,
      linkKey: null,
      reason: null,
      threadId: thread.threadId,
      toState: null,
      ...details,
    }),
    'event',
  );
  db.query('INSERT INTO work_thread_events(event_id, thread_id, at, event_json) VALUES (?, ?, ?, ?)').run(
    event.eventId,
    thread.threadId,
    event.at,
    JSON.stringify(event),
  );
};

const addLink = (db: SqliteDatabase, link: Omit<WorkThreadLink, 'linkId' | 'detachedAt'>): void => {
  const validatedLink = validated(
    parseWorkThreadLink({
      ...link,
      key: canonicalLinkKey(link.kind, link.key),
      detachedAt: null,
      linkId: randomUUID(),
    }),
    'link write',
  );
  db.query(`INSERT INTO work_thread_links(link_id, thread_id, kind, link_key, provenance, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    validatedLink.linkId,
    link.threadId,
    link.kind,
    validatedLink.key,
    link.provenance,
    link.createdAt,
  );
};

const newThread = (input: {
  readonly now: CanonicalInstant;
  readonly machineId: string;
  readonly title: string;
  readonly projectLabel: string | null;
  readonly intent: WorkThreadIntent | null;
  readonly objective: string | null;
  readonly origin: WorkThread['origin'];
  readonly originKey: string | null;
}): WorkThread => {
  const parsed = parseWorkThread({
    createdAt: input.now,
    doneAt: null,
    doneReason: null,
    followRevision: 1,
    followState: 'following',
    intent: input.intent,
    machineId: input.machineId,
    note: null,
    objective: input.objective,
    origin: input.origin,
    originKey: input.originKey,
    projectLabel: input.projectLabel,
    threadId: randomUUID(),
    title: input.title,
    updatedAt: input.now,
    waitingFor: null,
    waitingOn: null,
  });
  return parsed ?? invalidInput('Invalid new work thread');
};

/** The kept task and its active members, as a subquery of thread ids for `alias.thread_id`. */
const taskThreadsSql = (alias: string): string =>
  `(SELECT ${alias}.thread_id UNION ALL SELECT combination.member_thread_id FROM work_thread_combinations combination
    WHERE combination.kept_thread_id = ${alias}.thread_id AND combination.separated_at IS NULL)`;

/** True for a task combined into another (hidden from lists, read-only for commands). */
const notCombinedMemberSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM work_thread_combinations combination
    WHERE combination.member_thread_id = ${alias}.thread_id AND combination.separated_at IS NULL)`;

const success = (thread: WorkThread, applied = true): WorkThreadCommandResult => ({
  applied,
  followRevision: thread.followRevision,
  ok: true,
  threadId: thread.threadId,
});
const failure = (
  kind: Extract<WorkThreadCommandResult, { ok: false }>['failure'],
  message: string,
  currentRevision: number | null = null,
): WorkThreadCommandResult => ({ currentRevision, failure: kind, message, ok: false });

const replayResult = (value: unknown): WorkThreadCommandResult | WorkIntakeCommandResult => {
  const result = record(json(record(value).result_json));
  if (
    result.ok === true &&
    typeof result.applied === 'boolean' &&
    (result.threadId === null || isWorkThreadId(result.threadId)) &&
    typeof result.followRevision === 'number' &&
    Number.isSafeInteger(result.followRevision) &&
    result.followRevision >= 1
  ) {
    return isWorkThreadId(result.threadId)
      ? { applied: false, followRevision: result.followRevision, ok: true, threadId: result.threadId }
      : { applied: false, followRevision: INTAKE_RESULT_REVISION, ok: true, threadId: null };
  }
  if (
    result.ok === false &&
    typeof result.message === 'string' &&
    (result.currentRevision === null ||
      (typeof result.currentRevision === 'number' &&
        Number.isSafeInteger(result.currentRevision) &&
        result.currentRevision >= 1))
  ) {
    const kind = WORK_THREAD_COMMAND_FAILURES.find((entry) => entry === result.failure);
    if (kind) {
      return failure(kind, result.message, result.currentRevision);
    }
  }
  return validated<WorkThreadCommandResult>(null, 'command result');
};

const applyFollowState = (
  db: SqliteDatabase,
  thread: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'set-follow-state' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  if (thread.followRevision !== command.expectedRevision) {
    return failure(
      'revision-conflict',
      'The follow state changed since this command was prepared',
      thread.followRevision,
    );
  }
  if (thread.followState === command.to || (thread.followState === 'done' && command.to !== 'following')) {
    return failure('invalid-transition', 'This follow-state transition is not allowed', thread.followRevision);
  }
  const next: WorkThread = {
    ...thread,
    followRevision: thread.followRevision + 1,
    followState: command.to,
    updatedAt: now,
    doneAt: command.to === 'done' ? now : null,
    doneReason: command.to === 'done' ? command.reason : null,
    waitingFor: command.to === 'waiting' ? command.waitingFor : null,
    waitingOn: command.to === 'waiting' ? command.waitingOn : null,
  };
  saveThread(db, next);
  addEvent(db, next, now, 'follow-state', {
    acknowledgedRemainders: command.acknowledgedRemainders,
    fromState: thread.followState,
    toState: next.followState,
    reason: command.reason,
  });
  return success(next);
};

const applyLink = (
  db: SqliteDatabase,
  thread: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'link' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  if (
    db
      .query(
        `SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = ? AND ${comparableLinkSql(command.kind)} = ? AND detached_at IS NULL`,
      )
      .get(thread.threadId, command.kind, canonicalLinkKey(command.kind, command.key)) !== null
  ) {
    return success(thread, false);
  }
  const active = record(
    db
      .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
      .get(thread.threadId),
  );
  if (typeof active.count !== 'number' || active.count >= WORK_THREAD_BOUNDS.maxLinksPerThread) {
    return failure('invalid-link', 'The thread has reached its active link limit', thread.followRevision);
  }
  addLink(db, { createdAt: now, key: command.key, kind: command.kind, provenance: 'user', threadId: thread.threadId });
  saveThread(db, { ...thread, updatedAt: now });
  addEvent(db, thread, now, 'link-added', { linkKey: command.key });
  return success(thread);
};

/**
 * Combine the tasks following one ticket (ADR 0080). The engine recomputes the group from current
 * evidence inside this transaction: the operator approved exactly these tasks for this ticket, so
 * any difference is `stale-preview`, never a silent adjustment.
 */
const applyCombine = (
  db: SqliteDatabase,
  machineId: string,
  kept: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'combine' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  const ticketKey = canonicalLinkKey('jira-issue', command.ticketKey);
  const expected = new Map(command.participants.map((item) => [item.threadId, item.expectedRevision]));
  const group = new Set((openTasksByTicket(db, machineId).get(ticketKey) ?? []).map((thread) => thread.threadId));
  const threads: WorkThread[] = [];
  for (const threadId of expected.keys()) {
    const thread = readThread(db, threadId);
    if (!thread || thread.machineId !== machineId) {
      return failure('not-found', 'A task of this combination was not found', kept.followRevision);
    }
    threads.push(thread);
  }
  if (group.size !== expected.size || [...group].some((threadId) => !expected.has(threadId))) {
    return failure(
      'stale-preview',
      'The tasks following this ticket changed since the preview; review the combination again.',
      kept.followRevision,
    );
  }
  for (const thread of threads) {
    if (thread.followRevision !== expected.get(thread.threadId)) {
      return failure('revision-conflict', `“${thread.title}” changed since the preview`, thread.followRevision);
    }
  }
  if (keptThreadFor(threads, ticketKey)?.threadId !== kept.threadId) {
    return failure('stale-preview', 'Another task now keeps this combination; review it again.', kept.followRevision);
  }
  const blockers = combineBlockers(db, threads);
  if (blockers.length > 0) {
    return failure('invalid-transition', blockers.join(' '), kept.followRevision);
  }
  // Revisions advance so a follow-state command prepared before the combination conflicts.
  const nextKept = { ...kept, followRevision: kept.followRevision + 1, updatedAt: now };
  saveThread(db, nextKept);
  const members = threads.filter((thread) => thread.threadId !== kept.threadId);
  for (const member of members) {
    db.query(`INSERT INTO work_thread_combinations(member_thread_id, kept_thread_id, ticket_key, combined_at,
      combine_command_id) VALUES (?, ?, ?, ?, ?)`).run(
      member.threadId,
      kept.threadId,
      ticketKey,
      now,
      command.commandId,
    );
    const next = { ...member, followRevision: member.followRevision + 1, updatedAt: now };
    saveThread(db, next);
    addEvent(db, next, now, 'combined', { linkKey: ticketKey, reason: `Combined into “${kept.title}”` });
  }
  addEvent(db, nextKept, now, 'combined', {
    linkKey: ticketKey,
    reason:
      `Combined ${members.length} ${members.length === 1 ? 'task' : 'tasks'}: ${members.map((member) => `“${member.title}”`).join(', ')}`.slice(
        0,
        WORK_THREAD_BOUNDS.maxNote,
      ),
  });
  return success(nextKept);
};

/** End a combination: members return with the state they kept; work done on the kept task stays. */
const applySeparate = (
  db: SqliteDatabase,
  kept: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'separate' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  if (kept.followRevision !== command.expectedRevision) {
    return failure('revision-conflict', 'The task changed since this command was prepared', kept.followRevision);
  }
  const memberIds = memberThreadIdsOf(db, kept.threadId);
  if (memberIds.length === 0) {
    return failure('invalid-transition', 'No task is combined into this one', kept.followRevision);
  }
  const wait = kept.waitingOn;
  if (
    wait !== null &&
    db
      .query(
        `SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = ? AND detached_at IS NULL
        AND ${comparableLinkSql(waitLinkKind(wait.kind))} = ?`,
      )
      .get(kept.threadId, waitLinkKind(wait.kind), canonicalLinkKey(waitLinkKind(wait.kind), wait.linkKey)) === null
  ) {
    return failure(
      'invalid-transition',
      'This task waits on a link that would leave with a separated task; change the wait first.',
      kept.followRevision,
    );
  }
  db.query(
    'UPDATE work_thread_combinations SET separated_at = ?, separate_command_id = ? WHERE kept_thread_id = ? AND separated_at IS NULL',
  ).run(now, command.commandId, kept.threadId);
  const nextKept = { ...kept, followRevision: kept.followRevision + 1, updatedAt: now };
  saveThread(db, nextKept);
  addEvent(db, nextKept, now, 'separated', {
    reason: `Separated ${memberIds.length} ${memberIds.length === 1 ? 'task' : 'tasks'}`,
  });
  for (const memberId of memberIds) {
    const member = readThread(db, memberId);
    if (member) {
      const next = { ...member, followRevision: member.followRevision + 1, updatedAt: now };
      saveThread(db, next);
      addEvent(db, next, now, 'separated', { reason: `Separated from “${kept.title}”` });
    }
  }
  return success(nextKept);
};

/** Intake decisions carry no follow state; the fixed revision only satisfies the result shape. */
const INTAKE_RESULT_REVISION = 1;

const applyIntakeDismissal = (
  db: SqliteDatabase,
  machineId: string,
  command: Extract<WorkThreadCommand, { op: 'dismiss-intake' }>,
  now: CanonicalInstant,
): WorkIntakeCommandResult => {
  const key = canonicalLinkKey('jira-issue', command.key);
  const row = db
    .query('SELECT dismissed_at FROM work_jira_intake WHERE machine_id = ? AND link_key = ?')
    .get(machineId, key);
  const dismissedAt = command.dismissed ? now : null;
  if (row === null) {
    // Dismissing before discovery returned the issue still records the operator's choice.
    db.query(`INSERT INTO work_jira_intake(machine_id, link_key, first_seen_at, assigned, assigned_at, dismissed_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run(machineId, key, now, now, dismissedAt);
  } else if ((record(row).dismissed_at !== null) === command.dismissed) {
    return { applied: false, followRevision: INTAKE_RESULT_REVISION, ok: true, threadId: null };
  } else {
    db.query('UPDATE work_jira_intake SET dismissed_at = ? WHERE machine_id = ? AND link_key = ?').run(
      dismissedAt,
      machineId,
      key,
    );
  }
  return { applied: true, followRevision: INTAKE_RESULT_REVISION, ok: true, threadId: null };
};

const executeCommand = (
  db: SqliteDatabase,
  input: ApplyWorkThreadCommandInput,
  now: CanonicalInstant,
): WorkThreadCommandResult | WorkIntakeCommandResult => {
  let normalized: unknown = input.command;
  if (input.command.op === 'create' && Array.isArray(input.command.links)) {
    normalized = { ...input.command, links: input.command.links.map(normalizeCommandLink) };
  } else if (input.command.op === 'link') {
    normalized = normalizeCommandLink(input.command);
  }
  const command = parseWorkThreadCommand(normalized);
  if (!command) {
    if (
      input.command.op === 'link' &&
      isWorkThreadId(input.command.threadId) &&
      typeof input.command.key === 'string' &&
      !parseWorkThreadLinkKey(input.command.kind, input.command.key)
    ) {
      return failure(
        'invalid-link',
        'The link key is not qualified for its kind',
        readThread(db, input.command.threadId)?.followRevision ?? null,
      );
    }
    return invalidInput('Invalid work thread command');
  }
  if (command.op === 'create') {
    const thread = newThread({ ...command, machineId: input.machineId, now, origin: 'user', originKey: null });
    saveThread(db, thread);
    const seen = new Set<string>();
    for (const link of command.links) {
      const identity = JSON.stringify([link.kind, canonicalLinkKey(link.kind, link.key)]);
      if (!seen.has(identity)) {
        addLink(db, { ...link, createdAt: now, provenance: 'user', threadId: thread.threadId });
        seen.add(identity);
      }
    }
    addEvent(db, thread, now, 'created', { toState: 'following' });
    return success(thread);
  }
  if (command.op === 'dismiss-intake') {
    return applyIntakeDismissal(db, input.machineId, command, now);
  }
  const thread = readThread(db, command.threadId);
  if (!thread) {
    return failure('not-found', 'The work thread was not found');
  }
  const keptId = keptThreadIdOf(db, thread.threadId);
  if (keptId !== null) {
    const kept = readThread(db, keptId);
    return failure(
      'task-combined',
      `This task was combined into “${kept?.title ?? keptId}”; act on that task or separate it first.`,
      thread.followRevision,
    );
  }
  switch (command.op) {
    case 'combine':
      return applyCombine(db, input.machineId, thread, command, now);
    case 'separate':
      return applySeparate(db, thread, command, now);
    case 'set-follow-state':
      return applyFollowState(db, thread, command, now);
    case 'link':
      return applyLink(db, thread, command, now);
    case 'detach-link': {
      // A kept task shows its members' links as its own: detaching one detaches every active copy
      // of that key across the combination, so it cannot stay attached through another member.
      const group = JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)]);
      const row = db
        .query('SELECT * FROM work_thread_links WHERE link_id = ? AND thread_id IN (SELECT value FROM json_each(?))')
        .get(command.linkId, group);
      if (row === null) {
        return failure('invalid-link', 'The link does not belong to this thread', thread.followRevision);
      }
      const link = linkFromRecord(row);
      if (link.detachedAt !== null) {
        return success(thread, false);
      }
      db.query(
        `UPDATE work_thread_links SET detached_at = ? WHERE detached_at IS NULL AND kind = ?
        AND ${comparableLinkSql(link.kind)} = ? AND thread_id IN (SELECT value FROM json_each(?))`,
      ).run(now, link.kind, canonicalLinkKey(link.kind, link.key), group);
      saveThread(db, { ...thread, updatedAt: now });
      addEvent(db, thread, now, 'link-detached', { linkKey: link.key });
      return success(thread);
    }
    case 'detach-session': {
      const group = JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)]);
      const active = db
        .query(`SELECT 1 FROM work_thread_links WHERE kind = 'session' AND link_key = ? AND detached_at IS NULL
          AND thread_id IN (SELECT value FROM json_each(?))`)
        .get(command.key, group);
      if (active === null) {
        const vetoed = db
          .query(`SELECT 1 FROM work_thread_links WHERE kind = 'session' AND link_key = ?
            AND thread_id IN (SELECT value FROM json_each(?))`)
          .get(command.key, group);
        if (vetoed !== null) {
          return success(thread, false);
        }
        // A session read through the branch has no stored link; the detached row is the veto.
        db.query(`INSERT INTO work_thread_links(link_id, thread_id, kind, link_key, provenance, created_at, detached_at)
          VALUES (?, ?, 'session', ?, 'user', ?, ?)`).run(randomUUID(), thread.threadId, command.key, now, now);
      } else {
        db.query(`UPDATE work_thread_links SET detached_at = ? WHERE kind = 'session' AND link_key = ?
          AND detached_at IS NULL AND thread_id IN (SELECT value FROM json_each(?))`).run(now, command.key, group);
      }
      saveThread(db, { ...thread, updatedAt: now });
      addEvent(db, thread, now, 'link-detached', { linkKey: command.key });
      return success(thread);
    }
    case 'set-note':
      if (thread.note === command.note) {
        return success(thread, false);
      }
      saveThread(db, { ...thread, note: command.note, updatedAt: now });
      addEvent(db, thread, now, 'note', { reason: command.note });
      return success(thread);
    case 'rename':
      if (thread.title === command.title) {
        return success(thread, false);
      }
      saveThread(db, { ...thread, title: command.title, updatedAt: now });
      addEvent(db, thread, now, 'renamed', { reason: command.title });
      return success(thread);
    default:
      return command satisfies never;
  }
};

const immediate = <Value>(db: SqliteDatabase, use: () => Value): Value => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = use();
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
};

const cursorScope = (query: WorkThreadListQuery): string => JSON.stringify([query.tab, query.project, query.search]);

/** Source change time and explicit operator events, evaluated before keyset pagination.
 * Discovery, polling and automatic links must not turn old work into new activity.
 */
// Aggregate each source once before joining task links; a page must not rescan every
// served transcript for every task (the 20,000-session fixture guards this boundary).
const sourceActivitySql = `source_activity AS MATERIALIZED (
 SELECT machine_id, kind, link_key, MAX(at) AS at FROM (
   SELECT machine_id, 'session' AS kind, 'session:' || machine_id || '/claude/' || cli_session_id AS link_key,
     last_activity_at AS at FROM claude_desktop_sessions
   UNION ALL
   SELECT d.machine_id, 'session', 'session:' || d.machine_id || '/claude/' || p.value, d.last_activity_at
     FROM claude_desktop_sessions d, json_each(d.prior_cli_session_ids_json) p
   UNION ALL
   SELECT s.machine_id, 'session', 'session:' || s.machine_id || '/' || json_extract(s.source_row_json, '$.source.harnessKey')
     || '/' || json_extract(s.source_row_json, '$.source.sourceSessionId'),
     strftime('%Y-%m-%dT%H:%M:%fZ', s.active_time / 1000.0, 'unixepoch')
     FROM served_report_rows s JOIN served_report_current c ON c.singleton = 1 AND c.revision = s.revision
     JOIN served_report_revisions r ON r.revision = s.revision AND r.complete = 1
     WHERE s.source_authority = 'local-observed'
   UNION ALL
   SELECT machine_id, 'pull-request', lower(host || '/' || repository || '#' || number),
     MAX(COALESCE(updated_at, ''), COALESCE(merged_at, ''), COALESCE(created_at, ''), COALESCE(closed_at, ''))
     FROM pull_request_observations WHERE outcome = 'observed'
   UNION ALL
   SELECT machine_id, 'jira-issue', 'jira:default/' || issue_key, updated_at
     FROM jira_issue_observations WHERE outcome = 'observed'
 ) WHERE at IS NOT NULL AND at != '' GROUP BY machine_id, kind, link_key
)`;

/** Roles that stand on their own on a branch; delegated sessions and reviews nest under a parent. */
const BRANCH_ROOT_ROLES = "('interactive', 'exec', 'unknown')";
/** A detached session link anywhere in the combination, not linked again, is the operator's veto. */
const branchSessionVetoSql = (thread: string, key: string): string => `NOT EXISTS (
  SELECT 1 FROM work_thread_links vetoed WHERE vetoed.kind = 'session' AND vetoed.detached_at IS NOT NULL
    AND vetoed.link_key = ${key} AND vetoed.thread_id IN ${taskThreadsSql(thread)}
    AND NOT EXISTS (SELECT 1 FROM work_thread_links relinked WHERE relinked.kind = 'session'
      AND relinked.link_key = vetoed.link_key AND relinked.detached_at IS NULL
      AND relinked.thread_id IN ${taskThreadsSql(thread)})
)`;

const BRANCH_SESSION_KEY_SQL = "'session:' || sb.machine_id || '/' || sb.harness || '/' || sb.session_id";

// A kept task's activity spans its combined members' events and links (ADR 0080).
const threadActivitySql = `COALESCE((SELECT MAX(at) FROM (
  SELECT e.at AS at FROM work_thread_events e WHERE e.thread_id IN ${taskThreadsSql('t')} AND (
    json_extract(e.event_json, '$.kind') IN ('follow-state', 'note', 'renamed', 'wait-satisfied', 'combined', 'separated')
    OR (json_extract(e.event_json, '$.kind') = 'created' AND t.origin IN ('user', 'session'))
    OR (json_extract(e.event_json, '$.kind') IN ('link-added', 'link-detached') AND EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id = e.thread_id AND l.provenance = 'user'
        AND l.link_key = json_extract(e.event_json, '$.linkKey')
    ))
  )
  UNION ALL
  SELECT a.at FROM work_thread_links l JOIN source_activity a
    ON a.machine_id = t.machine_id AND a.kind = l.kind AND a.link_key = CASE WHEN l.kind = 'pull-request' THEN lower(l.link_key) ELSE l.link_key END
    WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.detached_at IS NULL
  UNION ALL
  SELECT a.at FROM work_thread_links l
    JOIN work_session_branches sb ON sb.link_key = l.link_key AND sb.machine_id = t.machine_id
      AND sb.role IN ${BRANCH_ROOT_ROLES}
    JOIN source_activity a ON a.machine_id = t.machine_id AND a.kind = 'session' AND a.link_key = ${BRANCH_SESSION_KEY_SQL}
    WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.kind = 'branch' AND l.detached_at IS NULL
      AND ${branchSessionVetoSql('t', BRANCH_SESSION_KEY_SQL)}
  UNION ALL
  SELECT j.at FROM work_thread_links l JOIN pull_request_observations p
    ON p.machine_id = t.machine_id AND lower(l.link_key) = lower(p.host || '/' || p.repository || '#' || p.number)
    JOIN source_activity j ON j.machine_id = t.machine_id AND j.kind = 'jira-issue'
      AND instr('/' || p.head_ref || '/', '/' || substr(j.link_key, length('jira:default/') + 1) || '/') > 0
    WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.kind = 'pull-request' AND l.detached_at IS NULL AND p.outcome = 'observed'
      AND p.observed_at = (SELECT MAX(last.observed_at) FROM pull_request_observations last
        WHERE last.machine_id = p.machine_id AND last.host = p.host AND last.repository = p.repository AND last.number = p.number AND last.outcome = 'observed')
      AND NOT EXISTS (SELECT 1 FROM work_thread_links detached WHERE detached.thread_id IN ${taskThreadsSql('t')}
        AND detached.link_key = j.link_key AND detached.detached_at IS NOT NULL)
) WHERE at IS NOT NULL AND at != ''), t.created_at)`;

/**
 * Where a task's work lands: the repository of its latest observed pull request, members of a
 * combination included, else its stored label. A ticket's task otherwise reads as its Jira project.
 */
const threadProjectSql = (alias: string): string => `COALESCE((
  SELECT (
    -- Linked keys are stored lowercase; discovery keeps GitHub's own spelling, which reads better.
    SELECT spelled.repository FROM pull_request_observations spelled
    WHERE spelled.machine_id = chosen.machine_id AND spelled.host = chosen.host AND spelled.number = chosen.number
      AND lower(spelled.repository) = chosen.repository
    ORDER BY spelled.repository = lower(spelled.repository), spelled.observed_at DESC LIMIT 1
  ) FROM (
    SELECT p.machine_id, p.host, p.number, lower(p.repository) AS repository
    FROM work_thread_links l JOIN pull_request_observations p
      ON p.machine_id = ${alias}.machine_id AND p.outcome = 'observed'
      AND lower(l.link_key) = lower(p.host || '/' || p.repository || '#' || p.number)
    WHERE l.thread_id IN ${taskThreadsSql(alias)} AND l.kind = 'pull-request' AND l.detached_at IS NULL
    ORDER BY p.observed_at DESC, p.id DESC LIMIT 1
  ) chosen
), ${alias}.project_label)`;

const pageFilter = (query: WorkThreadListQuery): { sql: string; params: unknown[] } => {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > WORK_THREAD_VIEW_BOUNDS.maxPageSize ||
    (query.tab !== 'open' && query.tab !== 'done') ||
    (query.project !== null &&
      (typeof query.project !== 'string' || query.project.length > WORK_THREAD_BOUNDS.maxTitle)) ||
    (query.search !== null &&
      (typeof query.search !== 'string' || query.search.length > WORK_THREAD_VIEW_BOUNDS.maxSearch))
  ) {
    return invalidInput('Invalid work thread page query');
  }
  const conditions = [
    query.tab === 'done' ? "t.follow_state = 'done'" : "t.follow_state IN ('following', 'waiting')",
    notCombinedMemberSql('t'),
  ];
  const params: unknown[] = [];
  if (query.project !== null) {
    conditions.push('t.effective_project = ?');
    params.push(query.project);
  }
  if (query.search !== null && query.search.length > 0) {
    conditions.push(`(instr(lower(t.title), lower(?)) > 0 OR EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.detached_at IS NULL AND (
        instr(lower(l.link_key), lower(?)) > 0 OR (l.kind = 'session' AND l.link_key IN (
            SELECT 'session:' || session.machine_id || '/' ||
              json_extract(session.source_row_json, '$.source.harnessKey') || '/' ||
              json_extract(session.source_row_json, '$.source.sourceSessionId')
            FROM served_report_current current
            JOIN served_report_revisions revision USING (revision)
            JOIN served_report_rows session USING (revision)
            WHERE current.singleton = 1 AND revision.complete = 1
              AND instr(lower(json_extract(session.source_row_json, '$.sessionLabel')), lower(?)) > 0
            UNION ALL
            SELECT 'session:' || desktop.machine_id || '/claude/' || desktop.cli_session_id
            FROM claude_desktop_sessions desktop
            WHERE instr(lower(desktop.title), lower(?)) > 0
            UNION ALL
            SELECT 'session:' || desktop.machine_id || '/claude/' || prior.value
            FROM claude_desktop_sessions desktop, json_each(desktop.prior_cli_session_ids_json) prior
            WHERE instr(lower(desktop.title), lower(?)) > 0
        ))
      )
    ))`);
    params.push(query.search, query.search, query.search, query.search, query.search);
  }
  if (query.cursor !== null) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 2000) {
      return invalidInput('Invalid work thread cursor');
    }
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    } catch {
      return invalidInput('Invalid work thread cursor');
    }
    if (
      !isRecord(cursor) ||
      cursor.scope !== cursorScope(query) ||
      !isWorkThreadId(cursor.threadId) ||
      typeof cursor.at !== 'string' ||
      normalizeIsoTimestamp(cursor.at) !== cursor.at
    ) {
      return invalidInput('Invalid work thread cursor or changed query scope');
    }
    conditions.push('(t.activity_at < ? OR (t.activity_at = ? AND t.thread_id > ?))');
    params.push(cursor.at, cursor.at, cursor.threadId);
  }
  return { params, sql: conditions.join(' AND ') };
};

const hasKnownWorkThreadLink = (db: SqliteDatabase, kind: WorkThreadLinkKind, key: string): boolean =>
  db
    .query(`SELECT 1 FROM work_threads WHERE ${kind === 'pull-request' ? 'lower(origin_key)' : 'origin_key'} = ?`)
    .get(key) !== null ||
  db.query(`SELECT 1 FROM work_thread_links WHERE kind = ? AND ${comparableLinkSql(kind)} = ?`).get(kind, key) !== null;

const attachReconciledPullRequest = (
  db: SqliteDatabase,
  task: WorkThread,
  key: string,
  now: CanonicalInstant,
): void => {
  addLink(db, { threadId: task.threadId, kind: 'pull-request', key, provenance: 'declared', createdAt: now });
  saveThread(db, { ...task, updatedAt: now });
  addEvent(db, task, now, 'link-added', { linkKey: key });
};

// ---------------------------------------------------------------------------------------------
// Combined tasks (ADR 0080). A member keeps its links, events and state; while the combination is
// active, every task-level reading and automatic write resolves it to the kept task.
// ---------------------------------------------------------------------------------------------

const keptThreadIdOf = (db: SqliteDatabase, threadId: string): string | null => {
  const row = db
    .query('SELECT kept_thread_id FROM work_thread_combinations WHERE member_thread_id = ? AND separated_at IS NULL')
    .get(threadId);
  return row === null ? null : String(record(row).kept_thread_id);
};

const memberThreadIdsOf = (db: SqliteDatabase, keptThreadId: string): string[] =>
  db
    .query(
      `SELECT member_thread_id FROM work_thread_combinations WHERE kept_thread_id = ? AND separated_at IS NULL
      ORDER BY combination_id`,
    )
    .all(keptThreadId)
    .map((row) => String(record(row).member_thread_id));

/** The task that answers for `thread`: itself, or the task it is combined into. */
const effectiveThread = (db: SqliteDatabase, thread: WorkThread): WorkThread => {
  const kept = keptThreadIdOf(db, thread.threadId);
  return kept === null ? thread : (readThread(db, kept) ?? thread);
};

const MAX_TICKET_EVIDENCE_THREADS = 2000;

/**
 * Exactly which ticket each task follows, by the rule combinations use (stricter than routing):
 * its Jira origin, an active Jira link, or an active PR on a non-review task whose latest observed
 * head branch names exactly one key. A detached link to a ticket removes the task from it.
 */
const tasksByTicket = (db: SqliteDatabase, machineId: string): Map<string, Set<string>> => {
  const byTicket = new Map<string, Set<string>>();
  const add = (ticket: string, threadId: string) => {
    const group = byTicket.get(ticket) ?? new Set<string>();
    group.add(threadId);
    byTicket.set(ticket, group);
  };
  const vetoes = new Set(
    db
      .query(
        `SELECT l.thread_id || ' ' || l.link_key AS veto FROM work_thread_links l JOIN work_threads t USING(thread_id)
        WHERE t.machine_id = ? AND l.kind = 'jira-issue' AND l.detached_at IS NOT NULL`,
      )
      .all(machineId)
      .map((row) => String(record(row).veto)),
  );
  for (const row of db
    .query(
      `SELECT t.thread_id, t.origin_key AS ticket FROM work_threads t WHERE t.machine_id = ? AND t.origin = 'jira-issue'
      UNION SELECT l.thread_id, l.link_key FROM work_thread_links l JOIN work_threads t USING(thread_id)
        WHERE t.machine_id = ? AND l.kind = 'jira-issue' AND l.detached_at IS NULL
      LIMIT ?`,
    )
    .all(machineId, machineId, MAX_TICKET_EVIDENCE_THREADS)) {
    add(String(record(row).ticket), String(record(row).thread_id));
  }
  for (const row of db
    .query(
      `WITH latest AS (
        SELECT lower(host) || '/' || lower(repository) || '#' || number AS link_key, head_ref,
          ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
        FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
      )
      SELECT t.thread_id, latest.head_ref FROM work_threads t
      JOIN work_thread_links l ON l.thread_id = t.thread_id AND l.kind = 'pull-request' AND l.detached_at IS NULL
      JOIN latest ON latest.link_key = lower(l.link_key) AND latest.rank = 1
      WHERE t.machine_id = ? AND (t.intent IS NULL OR t.intent != 'review') LIMIT ?`,
    )
    .all(machineId, machineId, MAX_TICKET_EVIDENCE_THREADS)) {
    const keys = jiraKeysInBranch(String(record(row).head_ref ?? ''));
    const [key] = keys;
    if (keys.length === 1 && key !== undefined) {
      add(jiraIssueLinkKey({ key, site: 'default' }), String(record(row).thread_id));
    }
  }
  for (const [ticket, group] of byTicket) {
    for (const threadId of group) {
      if (vetoes.has(`${threadId} ${ticket}`)) {
        group.delete(threadId);
      }
    }
  }
  return byTicket;
};

/** Open tasks following each ticket: a Done follow-up is history and never joins a combination. */
const openTasksByTicket = (db: SqliteDatabase, machineId: string): Map<string, WorkThread[]> => {
  const result = new Map<string, WorkThread[]>();
  const threads = new Map<string, WorkThread | null>();
  for (const [ticket, ids] of tasksByTicket(db, machineId)) {
    const open: WorkThread[] = [];
    for (const threadId of ids) {
      if (!threads.has(threadId)) {
        threads.set(threadId, readThread(db, threadId));
      }
      const thread = threads.get(threadId);
      if (thread && thread.followState !== 'done') {
        open.push(thread);
      }
    }
    result.set(ticket, open);
  }
  return result;
};

const distinctActiveLinkCount = (db: SqliteDatabase, threadIds: readonly string[]): number => {
  const row = record(
    db
      .query(
        `SELECT COUNT(DISTINCT kind || ' ' || CASE WHEN kind = 'pull-request' THEN lower(link_key) ELSE link_key END)
        AS count FROM work_thread_links WHERE detached_at IS NULL AND thread_id IN (SELECT value FROM json_each(?))`,
      )
      .get(JSON.stringify(threadIds)),
  );
  return typeof row.count === 'number' ? row.count : Number.POSITIVE_INFINITY;
};

/** A key active on one participant but detached (an operator veto) on another. */
const crossVetoedKeys = (db: SqliteDatabase, threadIds: readonly string[]): string[] =>
  db
    .query(
      `SELECT DISTINCT active.link_key AS key FROM work_thread_links active JOIN work_thread_links detached
        ON detached.kind = active.kind AND detached.link_key = active.link_key AND detached.detached_at IS NOT NULL
        AND detached.thread_id != active.thread_id
      WHERE active.detached_at IS NULL AND active.thread_id IN (SELECT value FROM json_each(?))
        AND detached.thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(threadIds), JSON.stringify(threadIds))
    .map((row) => String(record(row).key));

/** Why a group cannot be combined yet; empty when it can. Readable as preview text. */
const combineBlockers = (db: SqliteDatabase, threads: readonly WorkThread[]): string[] => {
  const blockers: string[] = [];
  const ids = threads.map((thread) => thread.threadId);
  for (const thread of threads) {
    const name = `“${thread.title.slice(0, 60)}”`;
    if (thread.followState !== 'following') {
      blockers.push(`${name} is ${thread.followState === 'done' ? 'Done' : 'Waiting'}; resume following it first.`);
    }
    if (thread.intent === 'review') {
      blockers.push(`${name} is a review; a review stays its own task.`);
    }
    if (thread.note !== null) {
      blockers.push(`${name} has a note; move or clear it first.`);
    }
    if (keptThreadIdOf(db, thread.threadId) !== null || memberThreadIdsOf(db, thread.threadId).length > 0) {
      blockers.push(`${name} is already part of a combination.`);
    }
  }
  if (threads.length > WORK_THREAD_BOUNDS.maxCombinedThreads) {
    blockers.push(`More than ${WORK_THREAD_BOUNDS.maxCombinedThreads} tasks follow this ticket.`);
  }
  if (distinctActiveLinkCount(db, ids) > WORK_THREAD_BOUNDS.maxLinksPerThread) {
    blockers.push(`Together they hold more than ${WORK_THREAD_BOUNDS.maxLinksPerThread} links.`);
  }
  for (const key of crossVetoedKeys(db, ids)) {
    blockers.push(`${key} is detached from one task but active on another.`);
  }
  return blockers;
};

/** The ticket's own task keeps the combination; otherwise the oldest. */
const keptThreadFor = (threads: readonly WorkThread[], ticketKey: string): WorkThread | undefined =>
  threads.find((thread) => thread.originKey === ticketKey) ??
  threads.toSorted(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId),
  )[0];

interface JiraKeyFollowers {
  /** Done tasks following the ticket: a new PR does not silently reopen or join them. */
  readonly done: number;
  /** Following or Waiting tasks that follow the ticket, oldest first. */
  readonly open: readonly WorkThread[];
}

/**
 * Tasks that follow one Jira issue: by origin, by an active link, or (for change tasks) through an
 * active pull request whose latest head branch names the key as a whole segment. Review tasks only
 * count through an explicit link: a teammate's ticket is context. A detached link to the issue is
 * the operator's veto and removes that task.
 */
const jiraKeyFollowers = (db: SqliteDatabase, machineId: string, linkKey: string): JiraKeyFollowers => {
  const parsed = parseWorkThreadLinkKey('jira-issue', linkKey);
  if (parsed?.kind !== 'jira-issue') {
    return { done: 0, open: [] };
  }
  const vetoed = new Set(
    db
      .query(
        "SELECT thread_id FROM work_thread_links WHERE kind = 'jira-issue' AND link_key = ? AND detached_at IS NOT NULL",
      )
      .all(linkKey)
      .map((row) => String(record(row).thread_id)),
  );
  const tasks = new Map<string, WorkThread>();
  for (const row of db
    .query(
      `SELECT t.* FROM work_threads t WHERE t.machine_id = ? AND (t.origin_key = ? OR EXISTS (
        SELECT 1 FROM work_thread_links l WHERE l.thread_id = t.thread_id AND l.kind = 'jira-issue'
        AND l.link_key = ? AND l.detached_at IS NULL))`,
    )
    .all(machineId, linkKey, linkKey)) {
    const task = threadFromRecord(row);
    tasks.set(task.threadId, task);
  }
  // A cheap prefilter on the key text; the exact segment rule decides.
  const branches = db
    .query(
      `WITH latest AS (
        SELECT lower(host) || '/' || lower(repository) || '#' || number AS link_key, head_ref,
          ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
        FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
      )
      SELECT t.*, latest.head_ref AS routed_head_ref FROM work_threads t
      JOIN work_thread_links l ON l.thread_id = t.thread_id AND l.kind = 'pull-request' AND l.detached_at IS NULL
      JOIN latest ON latest.link_key = lower(l.link_key) AND latest.rank = 1
      WHERE t.machine_id = ? AND (t.intent IS NULL OR t.intent != 'review') AND latest.head_ref LIKE ?`,
    )
    .all(machineId, machineId, `%${parsed.key}%`);
  for (const row of branches) {
    const headRef = record(row).routed_head_ref;
    if (typeof headRef === 'string' && jiraKeysInBranch(headRef).includes(parsed.key)) {
      const task = threadFromRecord(row);
      tasks.set(task.threadId, task);
    }
  }
  // A combination answers as its kept task, and a veto on any of its tasks holds for all of them.
  const effective = new Map<string, WorkThread>();
  for (const task of tasks.values()) {
    const kept = effectiveThread(db, task);
    effective.set(kept.threadId, kept);
  }
  const vetoedTasks = new Set([...vetoed].map((threadId) => keptThreadIdOf(db, threadId) ?? threadId));
  const followers = [...effective.values()].filter((task) => !vetoedTasks.has(task.threadId));
  return {
    done: followers.filter((task) => task.followState === 'done').length,
    open: followers
      .filter((task) => task.followState !== 'done')
      .sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId),
      ),
  };
};

const activeLinkCount = (db: SqliteDatabase, threadId: string): number => {
  const count = record(
    db
      .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
      .get(threadId),
  ).count;
  return typeof count === 'number' ? count : Number.POSITIVE_INFINITY;
};

const branchEvidence = (linkKey: string): string => `Head branch names ${linkKey.slice(linkKey.lastIndexOf('/') + 1)}`;

/** The single open task holding a branch, as its kept task; none when several do or only Done ones. */
const openBranchHolder = (db: SqliteDatabase, branchKey: string): WorkThread | null => {
  const holders = new Map<string, WorkThread>();
  for (const row of db
    .query(`SELECT t.* FROM work_threads t WHERE t.origin_key = ? OR EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id = t.thread_id AND l.kind = 'branch'
        AND ${comparableLinkSql('branch')} = ? AND l.detached_at IS NULL)`)
    .all(branchKey, branchKey)) {
    const task = effectiveThread(db, threadFromRecord(row));
    holders.set(task.threadId, task);
  }
  const [holder] = holders.values();
  return holders.size === 1 && holder !== undefined && holder.followState !== 'done' ? holder : null;
};

/** Reuse only an unambiguous, operator-linked session task with no prior PR association. */
const reconciliationCandidates = (db: SqliteDatabase, input: SeedWorkThreadsInput): Map<string, WorkThread | null> => {
  const result = new Map<string, WorkThread | null>();
  const declarations = input.declarations ?? [];
  const incomplete = declarations.length > MAX_DECLARED_SESSION_LINKS || input.declarationsTruncated;
  const seedKeys = new Set(
    input.seeds
      .filter((seed) => seed.origin === 'pull-request')
      .map((seed) => canonicalLinkKey(seed.linkKind, seed.originKey)),
  );
  for (const key of input.observedPullRequestKeys ?? []) {
    const canonical = canonicalLinkKey('pull-request', key);
    if (!parseWorkThreadLinkKey('pull-request', canonical)) {
      return invalidInput('Observed PR identities must be qualified');
    }
    seedKeys.add(canonical);
  }
  const byPullRequest = new Map<string, { all: Set<string>; strong: Set<string> }>();
  for (const declaration of declarations.slice(0, MAX_DECLARED_SESSION_LINKS)) {
    const session = parseWorkThreadLinkKey('session', declaration.sessionKey);
    const key = canonicalLinkKey('pull-request', declaration.pullRequestKey);
    if (
      session?.kind !== 'session' ||
      session.machineId !== input.machineId ||
      !parseWorkThreadLinkKey('pull-request', key)
    ) {
      return invalidInput('Reconciliation requires qualified same-machine declarations');
    }
    const group = byPullRequest.get(key) ?? { all: new Set<string>(), strong: new Set<string>() };
    group.all.add(declaration.sessionKey);
    if (declaration.provenance === 'session-pr-link' && session.harness === 'claude') {
      group.strong.add(declaration.sessionKey);
    }
    byPullRequest.set(key, group);
  }
  for (const [key, group] of byPullRequest) {
    if (!seedKeys.has(key) || hasKnownWorkThreadLink(db, 'pull-request', key)) {
      continue;
    }
    const tasks = new Map<string, WorkThread>();
    const strongTasks = new Set<string>();
    for (const sessionKey of group.all) {
      const matches = db
        .query(
          `SELECT t.* FROM work_threads t WHERE t.machine_id = ? AND EXISTS (
          SELECT 1 FROM work_thread_links s WHERE s.thread_id = t.thread_id AND s.kind = 'session'
          AND s.link_key = ? AND s.detached_at IS NULL) ORDER BY t.thread_id LIMIT 2`,
        )
        .all(input.machineId, sessionKey);
      for (const value of matches) {
        const task = effectiveThread(db, threadFromRecord(value));
        tasks.set(task.threadId, task);
        if (group.strong.has(sessionKey)) {
          strongTasks.add(task.threadId);
        }
      }
    }
    if (tasks.size === 0) {
      continue;
    }
    const task = tasks.size === 1 ? [...tasks.values()][0] : undefined;
    const priorPR =
      task &&
      db
        .query("SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = 'pull-request' LIMIT 1")
        .get(task.threadId);
    const active =
      task &&
      record(
        db
          .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
          .get(task.threadId),
      ).count;
    result.set(
      key,
      !incomplete &&
        task &&
        strongTasks.has(task.threadId) &&
        priorPR === null &&
        typeof active === 'number' &&
        active < WORK_THREAD_BOUNDS.maxLinksPerThread
        ? task
        : null,
    );
  }
  // Reserve the whole batch per task; never choose one PR arbitrarily when capacity is insufficient.
  const additions = new Map<string, number>();
  for (const task of result.values()) {
    if (task) {
      additions.set(task.threadId, (additions.get(task.threadId) ?? 0) + 1);
    }
  }
  for (const [key, task] of result) {
    if (!task) {
      continue;
    }
    const active = record(
      db
        .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
        .get(task.threadId),
    ).count;
    if (
      typeof active !== 'number' ||
      active + (additions.get(task.threadId) ?? 0) > WORK_THREAD_BOUNDS.maxLinksPerThread
    ) {
      result.set(key, null);
    }
  }
  return result;
};

// ---------------------------------------------------------------------------------------------
// Branch evidence (ADR 0081). A session's harness records its repository and branch; a task holds
// the branch as a link. Sessions on that branch read as the task's, except delegated ones (nested
// under their parent) and the ones the operator detached.
// ---------------------------------------------------------------------------------------------

/** Sessions one task reads through its branches; older ones are left out and reported truncated. */
export const MAX_BRANCH_SESSIONS_PER_TASK = 60;
/** Only sessions this recent create a task; older history joins existing tasks only. */
export const BRANCH_TASK_CREATION_WINDOW_DAYS = 21;
const MAX_BRANCH_TASKS_PER_RUN = 25;
const MAX_HEAD_BRANCH_LINKS = 500;
const MAX_BRANCH_CANDIDATES = 500;

export interface ReconcileWorkBranchesInput {
  readonly dbPath: string;
  /** Resolves the default branch a checkout's `origin` names (`refs/remotes/origin/HEAD`), if known. */
  readonly defaultBranchOf?: (sourcePath: string) => string | null;
  /** SSH host alias → host, so `github-perso.com` remotes compare with `github.com` pull requests. */
  readonly hostAliases?: Readonly<Record<string, string>>;
  readonly machineId: string;
  readonly now: string;
  /** Branch names the operator's config declares shared, besides the conventional ones. */
  readonly sharedBranches?: readonly string[];
}

export interface ReconcileWorkBranchesResult {
  /** Branch links added to existing tasks: from a PR's head branch, or a ticket the branch names. */
  readonly branchLinks: number;
  readonly created: number;
  readonly indexed: boolean;
  /** Candidate branches left without a task: shared, a PR base, or no interactive session. */
  readonly suppressed: number;
  readonly truncated: boolean;
}

const currentServedRevision = (db: SqliteDatabase): string | null => {
  const value = db
    .query(`SELECT revisions.revision FROM served_report_current current
      JOIN served_report_revisions revisions USING(revision) WHERE current.singleton = 1 AND revisions.complete = 1`)
    .get();
  return value === null ? null : validated(evidenceText(record(value).revision, 512), 'served revision');
};

const sessionBranchRole = (row: Record<string, unknown>, delegatedBy: string | undefined): string => {
  if (row.origin === 'classifier') {
    return 'review';
  }
  if (row.origin === 'subagent' || typeof row.parent === 'string' || delegatedBy !== undefined) {
    return 'delegated';
  }
  if (row.launch_mode === 'exec') {
    return 'exec';
  }
  // Codex says how a run started; a row without it (an older collection) cannot create a task.
  if (row.harness === 'codex' && row.launch_mode !== 'interactive') {
    return 'unknown';
  }
  return row.origin === 'human' ? 'interactive' : 'unknown';
};

/** Rebuilds the index for `revision` unless it already exists for the same host aliases. */
const rebuildSessionBranches = (
  db: SqliteDatabase,
  revision: string,
  aliases: Readonly<Record<string, string>>,
  now: CanonicalInstant,
): boolean => {
  const aliasesJson = JSON.stringify(Object.entries(aliases).sort(([left], [right]) => left.localeCompare(right)));
  const built = db.query('SELECT aliases_json FROM work_session_branch_builds WHERE revision = ?').get(revision);
  if (built !== null && record(built).aliases_json === aliasesJson) {
    return false;
  }
  db.query('DELETE FROM work_session_branches').run();
  db.query('DELETE FROM work_session_branch_builds').run();
  // A Claude session titled after its id reads better under its Desktop title, when it has one.
  const desktopTitles = new Map<string, string>();
  for (const value of db
    .query(`SELECT machine_id, cli_session_id, title FROM claude_desktop_sessions
      UNION ALL SELECT desktop.machine_id, prior.value, desktop.title
      FROM claude_desktop_sessions desktop, json_each(desktop.prior_cli_session_ids_json) prior`)
    .all()) {
    const row = record(value);
    if (typeof row.title === 'string' && row.title.trim()) {
      desktopTitles.set(`${String(row.machine_id)}/${String(row.cli_session_id)}`, row.title.trim());
    }
  }
  // A `codex exec` a Claude session launched is listed on the parent only; invert that edge first.
  const delegatedBy = new Map<string, string>();
  for (const value of db
    .query(`SELECT machine_id, json_extract(source_row_json, '$.source.sourceSessionId') AS parent,
        json_extract(source_row_json, '$.source.delegatedSessions') AS delegated
      FROM served_report_rows WHERE revision = ? AND json_type(source_row_json, '$.source.delegatedSessions') = 'array'`)
    .all(revision)) {
    const row = record(value);
    for (const child of readWorkSessionDelegations(row.delegated).delegatedSessions) {
      delegatedBy.set(`${String(row.machine_id)}/${child.harness}/${child.sourceSessionId}`, String(row.parent));
    }
  }
  const insert = db.query(`INSERT OR IGNORE INTO work_session_branches(revision, link_key, machine_id, harness,
    session_id, role, repository_label, started_at, title, source_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A partial context (several repositories, truncated spans) is no evidence of where work happened.
  for (const value of db
    .query(`SELECT machine_id, json_extract(source_row_json, '$.source.harnessKey') AS harness,
        json_extract(source_row_json, '$.source.sourceSessionId') AS session_id,
        json_extract(source_row_json, '$.source.parentSourceSessionId') AS parent,
        json_extract(source_row_json, '$.origin') AS origin,
        json_extract(source_row_json, '$.source.launchMode') AS launch_mode,
        json_extract(source_row_json, '$.source.vcs.repository.host') AS host,
        json_extract(source_row_json, '$.source.vcs.repository.ownerPath') AS owner_path,
        json_extract(source_row_json, '$.source.vcs.branches') AS branches,
        json_extract(source_row_json, '$.source.sourcePath') AS source_path,
        json_extract(source_row_json, '$.date') AS started_at,
        json_extract(source_row_json, '$.sessionLabel') AS title,
        json_extract(source_row_json, '$.titleSource') AS title_source
      FROM served_report_rows WHERE revision = ?
        AND json_extract(source_row_json, '$.source.vcs.partial') = 0
        AND json_extract(source_row_json, '$.source.vcs.repository.host') IS NOT NULL
        AND json_array_length(json_extract(source_row_json, '$.source.vcs.branches')) > 0`)
    .all(revision)) {
    const row = record(value);
    if (
      typeof row.harness !== 'string' ||
      typeof row.session_id !== 'string' ||
      typeof row.host !== 'string' ||
      typeof row.owner_path !== 'string' ||
      typeof row.branches !== 'string'
    ) {
      continue;
    }
    const machineId = String(row.machine_id);
    const host = row.host.toLowerCase();
    const role = sessionBranchRole(row, delegatedBy.get(`${machineId}/${row.harness}/${row.session_id}`));
    const names = new Set<string>();
    const spans: unknown = JSON.parse(row.branches);
    for (const span of Array.isArray(spans) ? spans : []) {
      if (isRecord(span) && typeof span.name === 'string' && isBranchRefName(span.name)) {
        names.add(span.name);
      }
    }
    for (const name of names) {
      const key = `branch:${aliases[host] ?? host}/${row.owner_path.toLowerCase()}@${name}`;
      if (parseWorkThreadLinkKey('branch', key) === null) {
        continue;
      }
      insert.run(
        revision,
        key,
        machineId,
        row.harness,
        row.session_id,
        role,
        row.owner_path,
        normalizeIsoTimestamp(row.started_at),
        // A title made from the session id says nothing; the Desktop title or the branch reads better.
        (typeof row.title === 'string' && row.title_source !== 'id'
          ? row.title
          : (desktopTitles.get(`${machineId}/${row.session_id}`) ?? null)
        )?.slice(0, WORK_THREAD_BOUNDS.maxTitle) ?? null,
        typeof row.source_path === 'string' ? row.source_path : null,
      );
    }
  }
  db.query('INSERT INTO work_session_branch_builds(revision, built_at, aliases_json) VALUES (?, ?, ?)').run(
    revision,
    now,
    aliasesJson,
  );
  return true;
};

/** Stable per task and session, so a derived row keeps its identity across reads. */
const derivedLinkId = (threadId: string, key: string): string => {
  const hex = createHash('sha256').update(`${threadId}\n${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The sessions a task reads through its active branch links: newest first, bounded, vetoes applied. */
const branchSessionLinks = (
  db: SqliteDatabase,
  scope: Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'> & { readonly threadId: string },
): { readonly links: readonly WorkThreadLink[]; readonly truncated: boolean } => {
  const branchKeys = [
    ...new Set(
      scope.links
        .filter((link) => link.kind === 'branch' && link.detachedAt === null)
        .map((link) => canonicalLinkKey('branch', link.key)),
    ),
  ];
  if (
    branchKeys.length === 0 ||
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'work_session_branches'").get() === null
  ) {
    return { links: [], truncated: false };
  }
  const linked = new Set(scope.links.filter((link) => link.kind === 'session').map((link) => link.key));
  const rows = db
    .query(`SELECT ${BRANCH_SESSION_KEY_SQL} AS session_key, MIN(sb.started_at) AS started_at
      FROM work_session_branches sb, (SELECT ? AS thread_id) t
      WHERE sb.link_key IN (SELECT value FROM json_each(?)) AND sb.machine_id = ? AND sb.role IN ${BRANCH_ROOT_ROLES}
        AND ${branchSessionVetoSql('t', BRANCH_SESSION_KEY_SQL)}
      GROUP BY sb.machine_id, sb.harness, sb.session_id
      ORDER BY MIN(sb.started_at) DESC, session_key LIMIT ?`)
    .all(scope.threadId, JSON.stringify(branchKeys), scope.machineId, MAX_BRANCH_SESSIONS_PER_TASK + linked.size + 1)
    .map(record)
    .filter((row) => !linked.has(String(row.session_key)));
  return {
    truncated: rows.length > MAX_BRANCH_SESSIONS_PER_TASK,
    links: rows.slice(0, MAX_BRANCH_SESSIONS_PER_TASK).map((row) =>
      validated(
        parseWorkThreadLink({
          createdAt: normalizeIsoTimestamp(row.started_at) ?? '1970-01-01T00:00:00.000Z',
          detachedAt: null,
          key: row.session_key,
          kind: 'session',
          linkId: derivedLinkId(scope.threadId, String(row.session_key)),
          provenance: 'declared',
          threadId: scope.threadId,
        }),
        'branch session',
      ),
    ),
  };
};

interface BranchCandidate {
  readonly firstAt: CanonicalInstant;
  readonly key: string;
  readonly repositoryLabel: string;
  readonly sourcePath: string | null;
  readonly title: string | null;
}

export const createWorkThreadStore = (dependencies: WorkThreadStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;
  const write = <Value>(
    dbPath: string,
    operation: string,
    use: (db: SqliteDatabase) => Value,
  ): Effect.Effect<Value, UsageStoreError> =>
    withUsageStoreWriter(dbPath, (db) =>
      Effect.try({
        try: () => immediate(db, () => use(db)),
        catch: (cause) =>
          cause instanceof UsageStoreError ? cause : usageStoreError(operation, dbPath, cause, 'storage-failure'),
      }),
    );
  const read = <Value>(
    dbPath: string,
    operation: string,
    use: (db: SqliteDatabase) => Value,
  ): Effect.Effect<Value, UsageStoreError> =>
    withUsageStoreReader(dbPath, (db) =>
      Effect.try({
        try: () => {
          if (
            WORK_THREAD_TABLES.some(
              (table) => db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) === null,
            )
          ) {
            throw usageStoreError(
              operation,
              dbPath,
              new Error('The engine must migrate the work thread tables before they can be read'),
              'schema-too-old',
            );
          }
          return use(db);
        },
        catch: (cause) => (cause instanceof UsageStoreError ? cause : usageStoreReadError(operation, dbPath, cause)),
      }),
    );

  // A task command's result names its task; only an intake decision answers without one.
  function applyWorkThreadCommand(
    input: ApplyWorkThreadCommandInput & { readonly command: WorkThreadTaskCommand },
  ): Effect.Effect<WorkThreadCommandResult, UsageStoreError>;
  function applyWorkThreadCommand(
    input: ApplyWorkThreadCommandInput,
  ): Effect.Effect<WorkThreadCommandResult | WorkIntakeCommandResult, UsageStoreError>;
  function applyWorkThreadCommand(
    input: ApplyWorkThreadCommandInput,
  ): Effect.Effect<WorkThreadCommandResult | WorkIntakeCommandResult, UsageStoreError> {
    return write(input.dbPath, 'applyWorkThreadCommand', (db) => {
      if (!isWorkThreadId(input.command.commandId)) {
        return invalidInput('Invalid work thread command id');
      }
      const existing = db
        .query('SELECT result_json FROM work_thread_commands WHERE command_id = ?')
        .get(input.command.commandId);
      if (existing !== null) {
        return replayResult(existing);
      }
      const now = instant(input.now);
      const result = executeCommand(db, input, now);
      db.query('INSERT INTO work_thread_commands(command_id, result_json, recorded_at) VALUES (?, ?, ?)').run(
        input.command.commandId,
        JSON.stringify(result),
        now,
      );
      return result;
    });
  }

  const seedWorkThreads = (input: SeedWorkThreadsInput): Effect.Effect<SeedWorkThreadsResult, UsageStoreError> =>
    write(input.dbPath, 'seedWorkThreads', (db) => {
      const now = instant(input.now);
      let created = 0;
      let existing = 0;
      let uncertain = 0;
      // Compute every candidate before adding any PR: batch order cannot change identity.
      const candidates = reconciliationCandidates(db, input);
      for (const seed of input.seeds) {
        const originKey = canonicalLinkKey(seed.linkKind, seed.originKey);
        if (seed.origin !== seed.linkKind || !parseWorkThreadLinkKey(seed.linkKind, originKey)) {
          return invalidInput('Seed origin and qualified link key must match');
        }
        if (hasKnownWorkThreadLink(db, seed.linkKind, originKey)) {
          existing++;
          continue;
        }
        const candidate = candidates.get(originKey);
        if (candidate === null) {
          uncertain++;
        }
        if (candidate) {
          attachReconciledPullRequest(db, candidate, originKey, now);
          existing++;
          continue;
        }
        const branchKey = seed.branchKey ? canonicalLinkKey('branch', seed.branchKey) : null;
        if (branchKey !== null && !parseWorkThreadLinkKey('branch', branchKey)) {
          return invalidInput('A PR head branch key must be qualified');
        }
        // Branch equality is stronger evidence than a ticket key: the PR is that branch's work.
        const branchHolder = branchKey === null || seed.intent === 'review' ? null : openBranchHolder(db, branchKey);
        if (
          branchHolder !== null &&
          activeLinkCount(db, branchHolder.threadId) < WORK_THREAD_BOUNDS.maxLinksPerThread
        ) {
          addLink(db, {
            createdAt: now,
            key: originKey,
            kind: 'pull-request',
            provenance: 'declared',
            threadId: branchHolder.threadId,
          });
          saveThread(db, { ...branchHolder, updatedAt: now });
          addEvent(db, branchHolder, now, 'link-added', {
            linkKey: originKey,
            reason: `Head branch ${branchKey?.slice(branchKey.indexOf('@') + 1)}`,
          });
          existing++;
          continue;
        }
        const routingKey =
          seed.origin === 'pull-request' && seed.routingJiraKey
            ? canonicalLinkKey('jira-issue', seed.routingJiraKey)
            : null;
        if (routingKey !== null && !parseWorkThreadLinkKey('jira-issue', routingKey)) {
          return invalidInput('A routing Jira key must be qualified');
        }
        // One ticket, one delivery task: an authored PR joins the single open task that follows
        // its branch's ticket. Several followers, or a Done one, stay visible as separate tasks.
        const followers = routingKey === null ? null : jiraKeyFollowers(db, input.machineId, routingKey);
        const [joined] = followers?.open ?? [];
        if (
          routingKey !== null &&
          followers?.open.length === 1 &&
          joined &&
          activeLinkCount(db, joined.threadId) < WORK_THREAD_BOUNDS.maxLinksPerThread
        ) {
          addLink(db, {
            createdAt: now,
            key: originKey,
            kind: 'pull-request',
            provenance: 'declared',
            threadId: joined.threadId,
          });
          saveThread(db, { ...joined, updatedAt: now });
          addEvent(db, joined, now, 'link-added', { linkKey: originKey, reason: branchEvidence(routingKey) });
          existing++;
          continue;
        }
        const discoveredAt = instant(seed.discoveredAt);
        const thread = newThread({
          ...seed,
          originKey,
          machineId: input.machineId,
          now: discoveredAt,
          objective: null,
        });
        saveThread(db, { ...thread, updatedAt: now });
        addLink(db, {
          createdAt: discoveredAt,
          key: originKey,
          kind: seed.linkKind,
          provenance: 'origin',
          threadId: thread.threadId,
        });
        addEvent(db, thread, discoveredAt, 'created', { toState: 'following' });
        if (branchKey !== null && !hasKnownWorkThreadLink(db, 'branch', branchKey)) {
          addLink(db, {
            createdAt: discoveredAt,
            key: branchKey,
            kind: 'branch',
            provenance: 'declared',
            threadId: thread.threadId,
          });
        }
        if (routingKey !== null && followers?.open.length === 0 && followers.done === 0) {
          // The new task now follows the ticket, so later PRs and the Jira intake find it.
          addLink(db, {
            createdAt: discoveredAt,
            key: routingKey,
            kind: 'jira-issue',
            provenance: 'declared',
            threadId: thread.threadId,
          });
          addEvent(db, thread, discoveredAt, 'link-added', { linkKey: routingKey, reason: branchEvidence(routingKey) });
        }
        created++;
      }
      // Observation-only PRs never create a task. They may still enrich a proven followed session.
      const seededKeys = new Set(input.seeds.map((seed) => canonicalLinkKey(seed.linkKind, seed.originKey)));
      for (const [key, candidate] of candidates) {
        if (seededKeys.has(key) || hasKnownWorkThreadLink(db, 'pull-request', key)) {
          continue;
        }
        if (candidate === null) {
          uncertain++;
        } else {
          attachReconciledPullRequest(db, candidate, key, now);
          existing++;
        }
      }
      return { created, existing, uncertain };
    });

  /**
   * Branch evidence (ADR 0081), in one writer transaction: index the served revision's recorded
   * branches, give PR tasks their head branch, then route or create a task for each branch with
   * recent interactive work. Bounded; whatever is left over is reported truncated, never dropped.
   */
  const reconcileWorkBranches = (
    input: ReconcileWorkBranchesInput,
  ): Effect.Effect<ReconcileWorkBranchesResult, UsageStoreError> =>
    write(input.dbPath, 'reconcileWorkBranches', (db) => {
      const now = instant(input.now);
      const aliases: Record<string, string> = {};
      for (const [alias, host] of Object.entries(input.hostAliases ?? {})) {
        aliases[alias.toLowerCase()] = host.toLowerCase();
      }
      const shared = new Set([...SHARED_BRANCH_NAMES, ...(input.sharedBranches ?? [])]);
      const result = { branchLinks: 0, created: 0, indexed: false, suppressed: 0, truncated: false };
      const revision = currentServedRevision(db);
      if (revision === null) {
        return result;
      }
      result.indexed = rebuildSessionBranches(db, revision, aliases, now);

      // 1. A followed PR names its head branch: the task holds it, unless a fork's or vetoed.
      const heads = db
        .query(`WITH latest AS (
          SELECT lower(host) AS host, lower(repository) AS repository, number, head_ref, cross_repository,
            ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
          FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
        )
        SELECT l.thread_id, l.link_key AS pull_request_key, latest.host, latest.repository, latest.head_ref
        FROM work_thread_links l JOIN work_threads t ON t.thread_id = l.thread_id AND t.machine_id = ?
        JOIN latest ON latest.rank = 1 AND lower(l.link_key) = latest.host || '/' || latest.repository || '#' || latest.number
        WHERE l.kind = 'pull-request' AND l.detached_at IS NULL AND latest.cross_repository = 0
          AND latest.head_ref IS NOT NULL
        ORDER BY l.created_at, l.link_id LIMIT ?`)
        .all(input.machineId, input.machineId, MAX_HEAD_BRANCH_LINKS + 1)
        .map(record);
      result.truncated ||= heads.length > MAX_HEAD_BRANCH_LINKS;
      for (const head of heads.slice(0, MAX_HEAD_BRANCH_LINKS)) {
        const ref = String(head.head_ref);
        const key = `branch:${String(head.host)}/${String(head.repository)}@${ref}`;
        if (
          !isBranchRefName(ref) ||
          shared.has(ref) ||
          parseWorkThreadLinkKey('branch', key) === null ||
          hasKnownWorkThreadLink(db, 'branch', key)
        ) {
          continue;
        }
        const task = effectiveThread(db, validated(readThread(db, String(head.thread_id)), 'PR task'));
        if (activeLinkCount(db, task.threadId) >= WORK_THREAD_BOUNDS.maxLinksPerThread) {
          result.truncated = true;
          continue;
        }
        addLink(db, { createdAt: now, key, kind: 'branch', provenance: 'declared', threadId: task.threadId });
        addEvent(db, task, now, 'link-added', {
          linkKey: key,
          reason: `Head branch of ${String(head.pull_request_key)}`,
        });
        result.branchLinks++;
      }

      // 2. A branch with recent interactive work and no task: route it to its ticket, or create one.
      if (db.query('SELECT 1 FROM work_branch_reconciliation WHERE machine_id = ?').get(input.machineId) === null) {
        // The window is fixed when the feature first runs: older history never creates a task later.
        const cutoff = new Date(Date.parse(now) - BRANCH_TASK_CREATION_WINDOW_DAYS * 86_400_000).toISOString();
        db.query('INSERT INTO work_branch_reconciliation(machine_id, creation_cutoff_at) VALUES (?, ?)').run(
          input.machineId,
          cutoff,
        );
      }
      const cutoff = String(
        record(
          db
            .query('SELECT creation_cutoff_at FROM work_branch_reconciliation WHERE machine_id = ?')
            .get(input.machineId),
        ).creation_cutoff_at,
      );
      // A branch some observed PR has as its head is that PR's work: it waits for the PR's task to
      // hold it (once GitHub says the head is not a fork) rather than becoming a second task.
      const pullRequestHeads = new Set(
        db
          .query(`SELECT DISTINCT lower(host) || '/' || lower(repository) || '@' || head_ref AS head
            FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed' AND head_ref IS NOT NULL
              AND (cross_repository IS NULL OR cross_repository = 0)`)
          .all(input.machineId)
          .map((row) => String(record(row).head)),
      );
      const openBases = new Set(
        db
          .query(`WITH latest AS (
            SELECT lower(host) AS host, lower(repository) AS repository, base_ref, state,
              ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
            FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
          ) SELECT host || '/' || repository || '@' || base_ref AS base FROM latest
            WHERE rank = 1 AND state = 'OPEN' AND base_ref IS NOT NULL`)
          .all(input.machineId)
          .map((row) => String(record(row).base)),
      );
      const candidates = db
        .query(`WITH ranked AS (
          SELECT link_key, started_at, repository_label, title, source_path,
            ROW_NUMBER() OVER (PARTITION BY link_key ORDER BY started_at, session_id) AS rank
          FROM work_session_branches
          WHERE revision = ? AND machine_id = ? AND role = 'interactive' AND started_at >= ?
        ) SELECT * FROM ranked WHERE rank = 1 ORDER BY started_at, link_key LIMIT ?`)
        .all(revision, input.machineId, cutoff, MAX_BRANCH_CANDIDATES + 1)
        .map((value): BranchCandidate => {
          const row = record(value);
          return {
            firstAt: validated(normalizeIsoTimestamp(row.started_at), 'branch session start'),
            key: String(row.link_key),
            repositoryLabel: String(row.repository_label),
            sourcePath: typeof row.source_path === 'string' ? row.source_path : null,
            title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null,
          };
        });
      result.truncated ||= candidates.length > MAX_BRANCH_CANDIDATES;
      const defaults = new Map<string, string | null>();
      const defaultBranchOf = (sourcePath: string | null): string | null => {
        if (sourcePath === null || input.defaultBranchOf === undefined) {
          return null;
        }
        if (!defaults.has(sourcePath)) {
          defaults.set(sourcePath, input.defaultBranchOf(sourcePath));
        }
        return defaults.get(sourcePath) ?? null;
      };
      let created = 0;
      for (const candidate of candidates.slice(0, MAX_BRANCH_CANDIDATES)) {
        const parsed = parseWorkThreadLinkKey('branch', candidate.key);
        if (parsed?.kind !== 'branch' || hasKnownWorkThreadLink(db, 'branch', candidate.key)) {
          continue;
        }
        // Exclusions only stop creation; a session on such a branch still joins a task holding it.
        const branchOfRepository = `${parsed.host}/${parsed.repository}@${parsed.ref}`;
        if (
          shared.has(parsed.ref) ||
          defaultBranchOf(candidate.sourcePath) === parsed.ref ||
          openBases.has(branchOfRepository) ||
          pullRequestHeads.has(branchOfRepository)
        ) {
          result.suppressed++;
          continue;
        }
        const ticketKeys = jiraKeysInBranch(parsed.ref);
        const [ticket] = ticketKeys;
        const routingKey =
          ticketKeys.length === 1 && ticket !== undefined ? jiraIssueLinkKey({ key: ticket, site: 'default' }) : null;
        const followers = routingKey === null ? null : jiraKeyFollowers(db, input.machineId, routingKey);
        const [follower] = followers?.open ?? [];
        if (
          followers?.open.length === 1 &&
          follower &&
          activeLinkCount(db, follower.threadId) < WORK_THREAD_BOUNDS.maxLinksPerThread
        ) {
          addLink(db, {
            createdAt: now,
            key: candidate.key,
            kind: 'branch',
            provenance: 'declared',
            threadId: follower.threadId,
          });
          addEvent(db, follower, now, 'link-added', { linkKey: candidate.key, reason: `Branch names ${ticket}` });
          result.branchLinks++;
          continue;
        }
        if (created >= MAX_BRANCH_TASKS_PER_RUN) {
          result.truncated = true;
          continue;
        }
        const thread = newThread({
          intent: 'change',
          machineId: input.machineId,
          now: candidate.firstAt,
          objective: null,
          origin: 'session',
          originKey: candidate.key,
          projectLabel: candidate.repositoryLabel.slice(0, WORK_THREAD_BOUNDS.maxTitle),
          title: (candidate.title ?? parsed.ref).slice(0, WORK_THREAD_BOUNDS.maxTitle),
        });
        saveThread(db, { ...thread, updatedAt: now });
        addLink(db, {
          createdAt: candidate.firstAt,
          key: candidate.key,
          kind: 'branch',
          provenance: 'origin',
          threadId: thread.threadId,
        });
        addEvent(db, thread, candidate.firstAt, 'created', {
          toState: 'following',
          reason: `Sessions recorded branch ${parsed.ref}`,
        });
        if (routingKey !== null && followers?.open.length === 0 && followers.done === 0) {
          addLink(db, {
            createdAt: candidate.firstAt,
            key: routingKey,
            kind: 'jira-issue',
            provenance: 'declared',
            threadId: thread.threadId,
          });
          addEvent(db, thread, candidate.firstAt, 'link-added', {
            linkKey: routingKey,
            reason: `Branch names ${ticket}`,
          });
        }
        created++;
      }
      result.created = created;
      return result;
    });

  const attachDeclaredWorkThreadSessions = (
    input: AttachDeclaredWorkThreadSessionsInput,
  ): Effect.Effect<AttachDeclaredWorkThreadSessionsResult, UsageStoreError> =>
    write(input.dbPath, 'attachDeclaredWorkThreadSessions', (db) => {
      const now = instant(input.now);
      const declarations = new Map<string, DeclaredWorkThreadSession>();
      for (const declaration of input.declarations.slice(0, MAX_DECLARED_SESSION_LINKS)) {
        const pullRequestKey = canonicalLinkKey('pull-request', declaration.pullRequestKey);
        const session = parseWorkThreadLinkKey('session', declaration.sessionKey);
        if (
          !parseWorkThreadLinkKey('pull-request', pullRequestKey) ||
          session?.kind !== 'session' ||
          session.machineId !== input.machineId
        ) {
          return invalidInput('Declared sessions require qualified pull request and same-machine session keys');
        }
        declarations.set(JSON.stringify([pullRequestKey, declaration.sessionKey]), {
          pullRequestKey,
          sessionKey: declaration.sessionKey,
        });
      }
      const result = {
        linked: 0,
        existing: 0,
        detached: 0,
        truncated: input.declarations.length > MAX_DECLARED_SESSION_LINKS,
      };
      for (const { pullRequestKey, sessionKey } of declarations.values()) {
        // Keep detached history as an operator-owned veto; a later poll may only fill previously absent links.
        const scope = `FROM work_threads t WHERE t.machine_id = ? AND EXISTS (
          SELECT 1 FROM work_thread_links p WHERE p.thread_id = t.thread_id
          AND p.kind = 'pull-request' AND lower(p.link_key) = ? AND p.detached_at IS NULL)`;
        const history = `SELECT 1 FROM work_thread_links s WHERE s.thread_id = t.thread_id
          AND s.kind = 'session' AND s.link_key = ?`;
        const activeCount =
          '(SELECT COUNT(*) FROM work_thread_links a WHERE a.thread_id = t.thread_id AND a.detached_at IS NULL)';
        const stats = record(
          db
            .query(`SELECT
          COUNT(CASE WHEN EXISTS (${history} AND s.detached_at IS NULL) THEN 1 END) AS existing,
          COUNT(CASE WHEN EXISTS (${history} AND s.detached_at IS NOT NULL) THEN 1 END) AS detached,
          COUNT(CASE WHEN NOT EXISTS (${history}) AND ${activeCount} >= ? THEN 1 END) AS full
          ${scope}`)
            .get(
              sessionKey,
              sessionKey,
              sessionKey,
              WORK_THREAD_BOUNDS.maxLinksPerThread,
              input.machineId,
              pullRequestKey,
            ),
        );
        result.existing += validated(typeof stats.existing === 'number' ? stats.existing : null, 'existing link count');
        result.detached += validated(typeof stats.detached === 'number' ? stats.detached : null, 'detached link count');
        result.truncated ||= validated(typeof stats.full === 'number' ? stats.full : null, 'full thread count') > 0;
        const remaining = MAX_DECLARED_SESSION_LINKS - result.linked;
        const candidates = db
          .query(`SELECT t.* ${scope} AND NOT EXISTS (${history})
          AND ${activeCount} < ? ORDER BY t.thread_id LIMIT ?`)
          .all(input.machineId, pullRequestKey, sessionKey, WORK_THREAD_BOUNDS.maxLinksPerThread, remaining + 1);
        result.truncated ||= candidates.length > remaining;
        for (const candidate of candidates.slice(0, remaining)) {
          // A combined task's sessions belong to the kept task; skip one that already holds it.
          const thread = effectiveThread(db, threadFromRecord(candidate));
          if (
            db
              .query(
                `SELECT 1 FROM work_thread_links WHERE kind = 'session' AND link_key = ?
                AND thread_id IN (SELECT value FROM json_each(?))`,
              )
              .get(sessionKey, JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)])) !== null
          ) {
            continue;
          }
          addLink(db, {
            threadId: thread.threadId,
            kind: 'session',
            key: sessionKey,
            provenance: 'declared',
            createdAt: now,
          });
          saveThread(db, { ...thread, updatedAt: now });
          addEvent(db, thread, now, 'link-added', { linkKey: sessionKey });
          result.linked++;
        }
      }
      return result;
    });

  const queryWorkThreadWaitCandidates = (
    input: QueryWorkThreadWaitCandidatesInput,
  ): Effect.Effect<QueryWorkThreadWaitCandidatesResult, UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadWaitCandidates', (db) => {
      if (
        !(input.machineId && ['pull-request-review', 'jira-update'].includes(input.kind)) ||
        input.linkKeys.length > MAX_WAIT_CANDIDATES
      ) {
        return invalidInput('Invalid work thread wait scope');
      }
      const kind = waitLinkKind(input.kind);
      const keys = [...new Set(input.linkKeys.map((key) => canonicalLinkKey(kind, key)))];
      if (keys.some((key) => !parseWorkThreadLinkKey(kind, key))) {
        return invalidInput('Invalid work thread wait link');
      }
      if (keys.length === 0) {
        return { candidates: [], truncated: false };
      }
      const linkKey = kind === 'pull-request' ? 'lower(l.link_key)' : 'l.link_key';
      const waitKey =
        kind === 'pull-request'
          ? "lower(json_extract(t.waiting_on_json, '$.linkKey'))"
          : "json_extract(t.waiting_on_json, '$.linkKey')";
      const rows = db
        .query(`SELECT * FROM (
        SELECT t.*, l.link_id AS waited_link_id, ROW_NUMBER() OVER (
          PARTITION BY t.thread_id ORDER BY l.created_at, l.link_id) AS candidate_rank
        FROM work_threads t JOIN work_thread_links l ON l.thread_id IN ${taskThreadsSql('t')}
        WHERE t.machine_id = ? AND t.follow_state = 'waiting' AND ${notCombinedMemberSql('t')}
          AND json_extract(t.waiting_on_json, '$.kind') = ? AND l.kind = ? AND l.detached_at IS NULL
          AND ${linkKey} = ${waitKey} AND ${linkKey} IN (SELECT value FROM json_each(?))
      ) WHERE candidate_rank = 1 ORDER BY updated_at, thread_id LIMIT ?`)
        .all(input.machineId, input.kind, kind, JSON.stringify(keys), MAX_WAIT_CANDIDATES + 1);
      const historyByKey = new Map<string, readonly WorkThreadWaitFact[]>();
      const candidates = rows.slice(0, MAX_WAIT_CANDIDATES).map((row): WorkThreadWaitCandidate => {
        const thread = threadFromRecord(row);
        const waitingOn = validated(thread.waitingOn, 'wait candidate');
        const normalizedWait = { ...waitingOn, linkKey: canonicalLinkKey(kind, waitingOn.linkKey) };
        if (!historyByKey.has(normalizedWait.linkKey)) {
          historyByKey.set(normalizedWait.linkKey, storedWaitFacts(db, input.machineId, normalizedWait));
        }
        return {
          threadId: thread.threadId,
          followRevision: thread.followRevision,
          waitingOn: normalizedWait,
          linkId: validated(
            isWorkThreadId(record(row).waited_link_id) ? String(record(row).waited_link_id) : null,
            'wait link',
          ),
          history: historyByKey.get(normalizedWait.linkKey) ?? [],
        };
      });
      return { candidates, truncated: rows.length > MAX_WAIT_CANDIDATES };
    });

  const applyWorkThreadWaitObservations = (
    input: ApplyWorkThreadWaitObservationsInput,
  ): Effect.Effect<ApplyWorkThreadWaitObservationsResult, UsageStoreError> =>
    write(input.dbPath, 'applyWorkThreadWaitObservations', (db) => {
      const now = instant(input.now);
      if (
        !input.machineId ||
        input.candidates.length > MAX_WAIT_CANDIDATES ||
        (input.pullRequests?.length ?? 0) > MAX_WAIT_CANDIDATES ||
        (input.jiraIssues?.length ?? 0) > MAX_WAIT_CANDIDATES
      ) {
        return invalidInput('Invalid or over-bound work thread wait observations');
      }
      const incoming = new Map<string, WorkThreadWaitFact>();
      const add = (key: string, fact: WorkThreadWaitFact): void => {
        if (fact.observedAt <= now && (!incoming.has(key) || incoming.get(key)!.observedAt < fact.observedAt)) {
          incoming.set(key, fact);
        }
      };
      for (const value of input.pullRequests ?? []) {
        const observation = parsePullRequestObservation(value) ?? invalidInput('Invalid pull request wait observation');
        if (observation.machineId === input.machineId && observation.outcome === 'observed') {
          add(`${observation.host.toLowerCase()}/${observation.repository.toLowerCase()}#${observation.number}`, {
            observedAt: observation.observedAt,
            updatedAt: observation.updatedAt,
            mergedAt: observation.mergedAt,
            state: observation.state,
            value: observation.reviewDecision,
          });
        }
      }
      for (const value of input.jiraIssues ?? []) {
        const observation = parseJiraIssueObservation(value) ?? invalidInput('Invalid Jira wait observation');
        if (observation.machineId === input.machineId && observation.outcome === 'observed') {
          add(`jira:default/${observation.key}`, {
            observedAt: observation.observedAt,
            updatedAt: observation.updatedAt,
            mergedAt: null,
            state: null,
            value: observation.status,
          });
        }
      }
      const result = { satisfied: 0, unchanged: 0, unproven: 0 };
      for (const candidate of input.candidates) {
        const thread = readThread(db, candidate.threadId);
        const wait = thread?.waitingOn;
        const kind = waitLinkKind(candidate.waitingOn.kind);
        if (
          !thread ||
          thread.machineId !== input.machineId ||
          thread.followState !== 'waiting' ||
          thread.followRevision !== candidate.followRevision ||
          wait === null ||
          wait === undefined ||
          wait.kind !== candidate.waitingOn.kind ||
          wait.since !== candidate.waitingOn.since ||
          canonicalLinkKey(kind, wait.linkKey) !== candidate.waitingOn.linkKey ||
          keptThreadIdOf(db, thread.threadId) !== null ||
          db
            .query(
              `SELECT 1 FROM work_thread_links WHERE link_id = ? AND detached_at IS NULL
              AND thread_id IN (SELECT value FROM json_each(?))`,
            )
            .get(candidate.linkId, JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)])) ===
            null
        ) {
          result.unchanged++;
          continue;
        }
        const fact = incoming.get(candidate.waitingOn.linkKey);
        const facts = [...candidate.history];
        // Only facts successfully imported by the writer may satisfy an expectation.
        if (fact !== undefined) {
          const stored = storedWaitFacts(db, input.machineId, candidate.waitingOn, fact.observedAt);
          if (
            stored.some(
              (item) =>
                item.observedAt === fact.observedAt &&
                item.updatedAt === fact.updatedAt &&
                item.mergedAt === fact.mergedAt &&
                item.state === fact.state &&
                item.value === fact.value,
            )
          ) {
            facts.push(fact);
          }
        }
        const evidence = waitEvidence(candidate, facts, now);
        if (evidence.reason === null) {
          result.unchanged++;
          result.unproven += Number(evidence.unproven);
          continue;
        }
        const next: WorkThread = {
          ...thread,
          followState: 'following',
          followRevision: thread.followRevision + 1,
          waitingFor: null,
          waitingOn: null,
          updatedAt: now,
        };
        saveThread(db, next);
        addEvent(db, next, now, 'wait-satisfied', {
          fromState: 'waiting',
          toState: 'following',
          linkKey: candidate.waitingOn.linkKey,
          reason: evidence.reason,
        });
        result.satisfied++;
      }
      return result;
    });

  const queryWorkThreadsPage = (
    input: QueryWorkThreadsPageInput,
  ): Effect.Effect<QueryWorkThreadsPageResult, UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadsPage', (db) => {
      const { sql, params } = pageFilter(input.query);
      const records = db
        .query(`WITH ${sourceActivitySql}, activity AS MATERIALIZED (SELECT t.*, ${threadActivitySql} AS activity_at,
          ${threadProjectSql('t')} AS effective_project FROM work_threads t)
        SELECT t.* FROM activity t WHERE ${sql}
        ORDER BY t.activity_at DESC, t.thread_id ASC LIMIT ?`)
        .all(...params, input.query.limit + 1);
      const rows = records.slice(0, input.query.limit).map(
        (value): WorkThreadPageRow => ({
          lastActivityAt: parseCanonicalInstant(record(value).activity_at),
          thread: threadFromRecord(value),
        }),
      );
      const last = rows.at(-1);
      const nextCursor =
        records.length > input.query.limit && last
          ? Buffer.from(
              JSON.stringify({
                at: last.lastActivityAt,
                scope: cursorScope(input.query),
                threadId: last.thread.threadId,
              }),
            ).toString('base64url')
          : null;
      return { nextCursor, rows };
    });

  const queryWorkThreadById = (input: QueryWorkThreadByIdInput): Effect.Effect<WorkThread | null, UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadById', (db) => {
      const row = db
        .query(`SELECT t.*, ${threadProjectSql('t')} AS effective_project FROM work_threads t WHERE t.thread_id = ?`)
        .get(input.threadId);
      return row === null ? null : threadFromRecord(row);
    });

  const queryWorkThreadLinks = (
    input: QueryWorkThreadLinksInput,
  ): Effect.Effect<readonly WorkThreadLink[], UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadLinks', (db) => {
      const ids = [...new Set(input.threadIds)];
      if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
        return invalidInput('Invalid work thread link scope');
      }
      // Active links are all returned; detached history is the latest maxEventsPerThread per thread.
      return db
        .query(`SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY thread_id, (detached_at IS NULL) ORDER BY detached_at DESC, rowid DESC
          ) AS rank FROM work_thread_links WHERE thread_id IN (SELECT value FROM json_each(?))
        ) WHERE detached_at IS NULL OR rank <= ? ORDER BY thread_id, created_at, link_id`)
        .all(JSON.stringify(ids), WORK_THREAD_BOUNDS.maxEventsPerThread)
        .map(linkFromRecord);
    });

  const queryActiveWorkThreadLinks = (
    input: QueryActiveWorkThreadLinksInput,
  ): Effect.Effect<QueryActiveWorkThreadLinksResult, UsageStoreError> =>
    read(input.dbPath, 'queryActiveWorkThreadLinks', (db) => {
      if (
        !input.machineId ||
        (input.kind !== 'pull-request' && input.kind !== 'jira-issue') ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 500 ||
        (input.excludeObservedMerged !== undefined && typeof input.excludeObservedMerged !== 'boolean') ||
        (input.excludeObservedMerged === true && input.kind !== 'pull-request') ||
        (input.jiraSite !== undefined &&
          (input.kind !== 'jira-issue' || !parseWorkThreadLinkKey('jira-issue', `jira:${input.jiraSite}/TEST-1`)))
      ) {
        return invalidInput('Invalid active work thread link scope');
      }
      const pendingPullRequests = input.excludeObservedMerged === true;
      const latestObservations = pendingPullRequests
        ? `WITH latest_observations AS MATERIALIZED (
        SELECT lower(host) || '/' || lower(repository) || '#' || number AS link_key, outcome, state, merged_at, history,
          ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
        FROM pull_request_observations WHERE machine_id = ?
      )`
        : '';
      const eligibility = pendingPullRequests
        ? `AND NOT EXISTS (
        SELECT 1 FROM latest_observations observation WHERE observation.link_key = lower(links.link_key)
          AND observation.rank = 1 AND observation.outcome = 'observed' AND observation.state = 'MERGED'
          AND observation.history IS NOT NULL
          AND NOT coalesce((threads.follow_state = 'waiting'
            AND json_extract(threads.waiting_on_json, '$.kind') = 'pull-request-review'
            AND lower(json_extract(threads.waiting_on_json, '$.linkKey')) = lower(links.link_key)
            AND observation.merged_at > json_extract(threads.waiting_on_json, '$.since')), 0)
      )`
        : '';
      const params: unknown[] = pendingPullRequests ? [input.machineId] : [];
      params.push(input.machineId, input.kind);
      if (input.jiraSite !== undefined) {
        params.push(`jira:${input.jiraSite}/`);
      }
      params.push(input.limit + 1);
      const rows = db
        .query(`${latestObservations} SELECT * FROM (
        SELECT links.*, ROW_NUMBER() OVER (PARTITION BY ${input.kind === 'pull-request' ? 'lower(link_key)' : 'link_key'}
          ORDER BY links.created_at DESC, links.link_id) AS rank
        FROM work_thread_links links
        LEFT JOIN work_thread_combinations combination
          ON combination.member_thread_id = links.thread_id AND combination.separated_at IS NULL
        JOIN work_threads threads ON threads.thread_id = COALESCE(combination.kept_thread_id, links.thread_id)
        WHERE threads.machine_id = ? AND threads.follow_state != 'done'
          AND links.kind = ? AND links.detached_at IS NULL
          ${eligibility}
          ${input.jiraSite === undefined ? '' : 'AND instr(links.link_key, ?) = 1'}
      ) WHERE rank = 1 ORDER BY created_at DESC, link_id LIMIT ?`)
        .all(...params);
      return { links: rows.slice(0, input.limit).map(linkFromRecord), truncated: rows.length > input.limit };
    });

  const queryWorkThreadEvents = (
    input: QueryWorkThreadByIdInput | QueryWorkThreadLinksInput,
  ): Effect.Effect<readonly WorkThreadEvent[], UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadEvents', (db) => {
      const ids = [...new Set('threadIds' in input ? input.threadIds : [input.threadId])];
      if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
        return invalidInput('Invalid work thread event scope');
      }
      return db
        .query(`SELECT event_json FROM (
          SELECT thread_id, event_json, at, rowid AS sequence,
            ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY at DESC, rowid DESC) AS rank
          FROM work_thread_events WHERE thread_id IN (SELECT value FROM json_each(?))
        ) WHERE rank <= ? ORDER BY thread_id, at, sequence`)
        .all(JSON.stringify(ids), WORK_THREAD_BOUNDS.maxEventsPerThread)
        .map((value) => validated(parseWorkThreadEvent(json(record(value).event_json)), 'event'));
    });

  const countWorkThreads = (input: {
    readonly dbPath: string;
  }): Effect.Effect<{ readonly done: number; readonly open: number }, UsageStoreError> =>
    read(input.dbPath, 'countWorkThreads', (db) => {
      const row = record(
        db
          .query(`SELECT COUNT(CASE WHEN follow_state = 'done' THEN 1 END) AS done,
        COUNT(CASE WHEN follow_state IN ('following', 'waiting') THEN 1 END) AS open FROM work_threads t
        WHERE ${notCombinedMemberSql('t')}`)
          .get(),
      );
      return {
        done: validated(typeof row.done === 'number' ? row.done : null, 'count'),
        open: validated(typeof row.open === 'number' ? row.open : null, 'count'),
      };
    });

  const queryWorkThreadProjects = (input: {
    readonly dbPath: string;
  }): Effect.Effect<readonly string[], UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadProjects', (db) =>
      db
        .query(`SELECT DISTINCT project_label FROM (SELECT ${threadProjectSql('t')} AS project_label FROM work_threads t
      WHERE ${notCombinedMemberSql('t')}) WHERE project_label IS NOT NULL ORDER BY project_label LIMIT ?`)
        .all(WORK_THREAD_VIEW_BOUNDS.maxProjects)
        .map((value) =>
          validated(
            typeof record(value).project_label === 'string' ? String(record(value).project_label) : null,
            'project',
          ),
        ),
    );

  /** Assignment is recorded, never turned into a task: the operator chooses what to follow. */
  const recordJiraIntake = (input: RecordJiraIntakeInput): Effect.Effect<number, UsageStoreError> =>
    write(input.dbPath, 'recordJiraIntake', (db) => {
      const now = instant(input.now);
      if (input.keys.length > MAX_JIRA_INTAKE_KEYS) {
        return invalidInput('Too many assigned Jira issues for one intake record');
      }
      const keys = [...new Set(input.keys)].map((key) => jiraIssueLinkKey({ key, site: 'default' }));
      if (keys.some((key) => !parseWorkThreadLinkKey('jira-issue', key))) {
        return invalidInput('Assigned Jira issues must be qualified keys');
      }
      for (const key of keys) {
        db.query(`INSERT INTO work_jira_intake(machine_id, link_key, first_seen_at, assigned, assigned_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(machine_id, link_key) DO UPDATE SET assigned = 1, assigned_at = excluded.assigned_at`).run(
          input.machineId,
          key,
          now,
          now,
        );
      }
      if (input.complete) {
        db.query(
          `UPDATE work_jira_intake SET assigned = 0 WHERE machine_id = ? AND assigned = 1
          AND link_key NOT IN (SELECT value FROM json_each(?))`,
        ).run(input.machineId, JSON.stringify(keys));
      }
      return keys.length;
    });

  /** Assigned, undismissed issues that no open task follows, newest assignment first. */
  const queryJiraIntake = (input: QueryJiraIntakeInput): Effect.Effect<QueryJiraIntakeResult, UsageStoreError> =>
    read(input.dbPath, 'queryJiraIntake', (db) => {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_JIRA_INTAKE_KEYS) {
        return invalidInput('Invalid Jira intake limit');
      }
      const rows = db
        .query(
          `SELECT link_key, first_seen_at FROM work_jira_intake
          WHERE machine_id = ? AND assigned = 1 AND dismissed_at IS NULL
          ORDER BY first_seen_at DESC, link_key LIMIT ?`,
        )
        .all(input.machineId, MAX_JIRA_INTAKE_KEYS + 1);
      const items: JiraIntakeEntry[] = [];
      for (const row of rows.slice(0, MAX_JIRA_INTAKE_KEYS)) {
        const value = record(row);
        const key = String(value.link_key);
        if (jiraKeyFollowers(db, input.machineId, key).open.length === 0) {
          items.push({ firstSeenAt: instant(String(value.first_seen_at)), key });
        }
      }
      return {
        items: items.slice(0, input.limit),
        truncated: items.length > input.limit || rows.length > MAX_JIRA_INTAKE_KEYS,
      };
    });

  /** Active combinations touching these tasks, kept or member, with both titles. */
  const queryWorkThreadCombinations = (
    input: QueryWorkThreadLinksInput,
  ): Effect.Effect<readonly WorkThreadCombination[], UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadCombinations', (db) => {
      const ids = [...new Set(input.threadIds)];
      if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
        return invalidInput('Invalid work thread combination scope');
      }
      return db
        .query(
          `SELECT c.kept_thread_id, kept.title AS kept_title, c.member_thread_id, member.title AS member_title, c.ticket_key
          FROM work_thread_combinations c
          JOIN work_threads kept ON kept.thread_id = c.kept_thread_id
          JOIN work_threads member ON member.thread_id = c.member_thread_id
          WHERE c.separated_at IS NULL AND (c.kept_thread_id IN (SELECT value FROM json_each(?))
            OR c.member_thread_id IN (SELECT value FROM json_each(?)))
          ORDER BY c.combination_id`,
        )
        .all(JSON.stringify(ids), JSON.stringify(ids))
        .map((row): WorkThreadCombination => {
          const value = record(row);
          return {
            keptThreadId: String(value.kept_thread_id),
            keptTitle: String(value.kept_title),
            memberThreadId: String(value.member_thread_id),
            memberTitle: String(value.member_title),
            ticketKey: String(value.ticket_key),
          };
        });
    });

  /**
   * Tickets followed by several open tasks, each with the task that would be kept and what blocks
   * the combination. Groups already combined into one task are not proposed again.
   */
  const queryWorkThreadCombineSuggestions = (input: {
    readonly dbPath: string;
    readonly machineId: string;
  }): Effect.Effect<QueryWorkThreadCombineSuggestionsResult, UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadCombineSuggestions', (db) => {
      const items: WorkThreadCombineSuggestionEntry[] = [];
      let oversized = false;
      for (const [ticketKey, threads] of openTasksByTicket(db, input.machineId)) {
        const effective = new Set(threads.map((thread) => keptThreadIdOf(db, thread.threadId) ?? thread.threadId));
        const kept = keptThreadFor(threads, ticketKey);
        if (effective.size < 2 || !kept) {
          continue;
        }
        if (threads.length > WORK_THREAD_VIEW_BOUNDS.maxCombineParticipants) {
          oversized = true;
          continue;
        }
        items.push({
          blockers: combineBlockers(db, threads).slice(0, WORK_THREAD_VIEW_BOUNDS.maxCombineBlockers),
          keptThreadId: kept.threadId,
          participants: threads.map((thread) => {
            const links = db
              .query(
                `SELECT kind, link_key FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL
                AND kind IN ('pull-request', 'session')`,
              )
              .all(thread.threadId)
              .map(record);
            return {
              pullRequestKeys: links
                .filter((link) => link.kind === 'pull-request')
                .map((link) => String(link.link_key)),
              sessionCount: links.filter((link) => link.kind === 'session').length,
              thread,
            };
          }),
          ticketKey,
        });
      }
      items.sort((left, right) => left.ticketKey.localeCompare(right.ticketKey));
      return {
        items: items.slice(0, WORK_THREAD_VIEW_BOUNDS.maxCombineSuggestions),
        truncated: oversized || items.length > WORK_THREAD_VIEW_BOUNDS.maxCombineSuggestions,
      };
    });

  return {
    ...createWorkThreadSessionEvidenceStore(dependencies),
    queryJiraIntake,
    queryWorkThreadCombinations,
    queryWorkThreadCombineSuggestions,
    recordJiraIntake,
    applyWorkThreadCommand,
    applyWorkThreadWaitObservations,
    attachDeclaredWorkThreadSessions,
    reconcileWorkBranches,
    countWorkThreads,
    queryActiveWorkThreadLinks,
    queryWorkThreadById,
    queryWorkThreadEvents,
    queryWorkThreadLinks,
    queryWorkThreadProjects,
    queryWorkThreadWaitCandidates,
    queryWorkThreadsPage,
    seedWorkThreads,
  };
};

/** Exact linked-session evidence. Bounds apply after identity selection, never to a global recent list. */
export interface WorkThreadSessionEvidence {
  readonly branchCheckouts: readonly {
    readonly key: string;
    readonly machineId: string;
    readonly checkoutPath: string;
  }[];
  /** Sessions read through the task's branch links (ADR 0081), as links that are not stored. */
  readonly branchSessionLinks: readonly WorkThreadLink[];
  readonly generatedAt: CanonicalInstant | null;
  readonly revision: string | null;
  readonly sessions: readonly {
    readonly harness: string;
    /** Stored first-prompt excerpt only when the served row declares that title provenance. */
    readonly firstPrompt: string | null;
    readonly member: Omit<import('./work-session-join').ServedHarnessSessionMember, 'projectLabel' | 'rowId'> & {
      /** Native Desktop evidence has no served row or project label. */
      readonly projectLabel: string | null;
      readonly rowId: string | null;
    };
    readonly desktop: {
      readonly cliSessionId: string;
      readonly desktopSessionId: string;
      readonly archived: boolean;
      readonly format: string;
      readonly branch: string | null;
      readonly createdAt: CanonicalInstant;
      readonly cwd: string;
      readonly lastActivityAt: CanonicalInstant;
      readonly lastTurnReport: string | null;
      readonly observedAt: CanonicalInstant;
      readonly title: string;
      readonly turnSummary: { readonly needsAction: string | null; readonly detail: string } | null;
      readonly worktreePath: string | null;
    } | null;
  }[];
  readonly truncated: boolean;
}

export interface QueryWorkThreadSessionEvidenceInput {
  readonly dbPath: string;
  readonly links: readonly WorkThreadLink[];
  readonly machineId: string;
}

export interface QueryWorkThreadSessionEvidenceBatchInput {
  readonly dbPath: string;
  readonly threads: readonly {
    readonly threadId: string;
    readonly links: readonly WorkThreadLink[];
    readonly machineId: string;
  }[];
}

export interface WorkThreadSessionEvidenceBatchEntry {
  readonly evidence: WorkThreadSessionEvidence;
  readonly threadId: string;
}

const EVIDENCE_MEMBER_DETAILS = `
  CASE WHEN json_type(metadata.source_row_json, '$.source.delegatedSessions') IS NULL
      OR json_type(metadata.source_row_json, '$.source.delegatedSessions') = 'null' THEN NULL
    WHEN json_type(metadata.source_row_json, '$.source.delegatedSessions') = 'array'
      THEN substr(json_extract(metadata.source_row_json, '$.source.delegatedSessions'), 1, ${MAX_WORK_DELEGATIONS_JSON + 1})
    ELSE 'null' END AS delegated_sessions,
  json_extract(metadata.source_row_json, '$.source.sourcePath') AS checkout_path,
  json_extract(metadata.source_row_json, '$.source.vcs.branches[#-1].name') AS branch,
  json_extract(metadata.source_row_json, '$.date') AS started_at,
  json_extract(metadata.source_row_json, '$.endDate') AS ended_at,
  CASE WHEN json_type(metadata.source_row_json, '$.durationMs') IN ('integer', 'real')
    THEN json_extract(metadata.source_row_json, '$.durationMs') END AS duration_ms,
  json_extract(metadata.source_row_json, '$.sessionLabel') AS title,
  json_extract(metadata.source_row_json, '$.titleSource') AS title_source`;

const evidenceText = (value: unknown, maximum = 4096): string | null =>
  typeof value === 'string' && value.length <= maximum ? value : null;
const evidenceOptionalText = (value: unknown, maximum = 4096): string | null =>
  value === null || value === undefined ? null : validated(evidenceText(value, maximum), 'session metadata');

interface SessionEvidencePage {
  readonly branches: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly children: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly desktops: ReadonlyMap<string, Record<string, unknown>>;
  readonly generatedAt: CanonicalInstant | null;
  readonly nativeRoots: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly revision: string | null;
  readonly roots: ReadonlyMap<string, readonly Record<string, unknown>[]>;
}

const sessionEvidenceKey = (machineId: string, harness: string, sessionId: string): string =>
  `session:${machineId}/${harness}/${sessionId}`;

// A veto on any task of a combination holds for all of them (ADR 0080, 0081).
const nonDetachedSessionSql = (machine: string, harness: string, session: string): string => `NOT EXISTS (
  SELECT 1 FROM work_thread_links detached WHERE detached.thread_id IN ${taskThreadsSql('requested')}
    AND detached.kind = 'session' AND detached.detached_at IS NOT NULL
    AND detached.link_key = 'session:' || ${machine} || '/' || ${harness} || '/' || ${session}
    AND NOT EXISTS (SELECT 1 FROM work_thread_links relinked WHERE relinked.thread_id IN ${taskThreadsSql('requested')}
      AND relinked.kind = 'session' AND relinked.link_key = detached.link_key AND relinked.detached_at IS NULL)
)`;

const groupEvidenceRecords = (values: readonly unknown[]): Map<string, Record<string, unknown>[]> => {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const value of values) {
    const row = record(value);
    const key = validated(evidenceText(row.request_key), 'requested evidence key');
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  return grouped;
};

/** All page evidence uses one snapshot and a fixed number of identity-scoped SQL reads. */
const readSessionEvidencePage = (
  db: SqliteDatabase,
  scopes: readonly Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'>[],
): SessionEvidencePage => {
  for (const input of scopes) {
    if (
      input.links.length > WORK_THREAD_BOUNDS.maxLinksPerThread + MAX_BRANCH_SESSIONS_PER_TASK ||
      !input.machineId ||
      input.links.some((link) => parseWorkThreadLink(link) === null)
    ) {
      return invalidInput('Invalid linked session evidence scope');
    }
  }
  const nativeRequests = new Map<string, readonly string[]>();
  for (const scope of scopes) {
    for (const link of scope.links) {
      const parsed = link.detachedAt === null ? parseWorkThreadLinkKey(link.kind, link.key) : null;
      if (parsed?.kind === 'session' && parsed.harness === 'claude') {
        nativeRequests.set(link.key, [link.key, parsed.machineId, parsed.sessionId]);
      }
    }
  }
  // Only exact current CLI identities can supply a native root without a served row.
  // Two matches retain ambiguity rather than choosing a registry file by recency.
  const nativeRoots = groupEvidenceRecords(
    nativeRequests.size === 0
      ? []
      : db
          .query(`WITH requested AS (
          SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
            json_extract(value, '$[2]') AS session_id FROM json_each(?)
        ), ranked AS (
          SELECT requested.request_key, desktop.*,
            ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY desktop.id) AS rank
          FROM requested JOIN claude_desktop_sessions desktop
            ON desktop.machine_id = requested.machine AND desktop.cli_session_id = requested.session_id
        ) SELECT * FROM ranked WHERE rank <= 2 ORDER BY request_key, rank`)
          .all(JSON.stringify([...nativeRequests.values()])),
  );
  const currentValue = db
    .query(`SELECT revisions.revision, revisions.generated_at FROM served_report_current current
      JOIN served_report_revisions revisions USING(revision) WHERE current.singleton = 1 AND revisions.complete = 1`)
    .get();
  if (currentValue === null) {
    return {
      revision: null,
      generatedAt: null,
      roots: new Map(),
      children: new Map(),
      desktops: new Map(),
      branches: new Map(),
      nativeRoots,
    };
  }
  const current = record(currentValue);
  const revision = validated(evidenceText(current.revision, 512), 'served revision');
  const generatedAt = validated(normalizeIsoTimestamp(current.generated_at), 'served revision date');
  const sessionRequests = new Map<string, readonly string[]>();
  const branchRequests = new Map<string, readonly string[]>();
  for (const scope of scopes) {
    for (const link of scope.links) {
      if (link.detachedAt !== null) {
        continue;
      }
      const parsed = parseWorkThreadLinkKey(link.kind, link.key);
      if (parsed?.kind === 'session') {
        sessionRequests.set(link.key, [link.key, parsed.machineId, parsed.harness, parsed.sessionId]);
      } else if (parsed?.kind === 'branch') {
        const key = JSON.stringify([link.threadId, scope.machineId, link.key]);
        branchRequests.set(key, [
          key,
          scope.machineId,
          parsed.host.toLowerCase(),
          parsed.repository.toLowerCase(),
          parsed.ref,
          link.threadId,
        ]);
      }
    }
  }
  const memberCte = (identityFilter: string) => `members AS MATERIALIZED (
    SELECT ordinal, row_id, machine_id, project_label, campaign_root, origin, active_time,
      json_extract(source_row_json, '$.source.sourceSessionId') AS source_session_id,
      json_extract(source_row_json, '$.source.parentSourceSessionId') AS parent_session_id,
      json_extract(source_row_json, '$.source.harnessKey') AS harness_key
    FROM served_report_rows WHERE revision = ? AND (${identityFilter})
  )`;
  const requestedIdentityFilter = (identity: 'sourceSessionId' | 'parentSourceSessionId') => `
    ${identity === 'parentSourceSessionId' ? "json_extract(source_row_json, '$.source.parentSourceSessionId') IS NOT NULL AND" : ''}
    (machine_id, json_extract(source_row_json, '$.source.harnessKey'), json_extract(source_row_json, '$.source.${identity}'))
      IN (SELECT machine, harness, session_id FROM requested)`;
  const requestCte = `requested AS MATERIALIZED (
    SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
      json_extract(value, '$[2]') AS harness, json_extract(value, '$[3]') AS session_id
    FROM json_each(?)
  )`;
  const roots = groupEvidenceRecords(
    sessionRequests.size === 0
      ? []
      : db
          .query(`WITH ${requestCte}, ${memberCte(requestedIdentityFilter('sourceSessionId'))}, ranked AS (
      SELECT requested.request_key, members.*,
        ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY ordinal) AS rank
      FROM requested JOIN members ON machine_id = machine AND harness_key = harness AND source_session_id = session_id
    ) SELECT ranked.*, ${EVIDENCE_MEMBER_DETAILS} FROM ranked
      JOIN served_report_rows metadata ON metadata.revision = ? AND metadata.ordinal = ranked.ordinal
      WHERE rank <= 2 ORDER BY request_key, rank`)
          .all(JSON.stringify([...sessionRequests.values()]), revision, revision),
  );
  const desktopRequests = new Map<string, readonly string[]>();
  for (const [key, rows] of roots) {
    const request = sessionRequests.get(key);
    if (rows.length === 1 && request?.[2] === 'claude') {
      desktopRequests.set(key, request);
    }
  }
  const readDesktops = (requests: readonly (readonly string[])[]) =>
    new Map(
      (requests.length === 0
        ? []
        : db
            .query(`WITH ${requestCte}, ranked AS (
        SELECT requested.request_key, desktop.*,
          ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY last_activity_at DESC, id DESC) AS rank
        FROM requested JOIN claude_desktop_sessions desktop ON desktop.machine_id = machine
          AND (cli_session_id = session_id OR EXISTS (
            SELECT 1 FROM json_each(prior_cli_session_ids_json) WHERE value = session_id))
      ) SELECT * FROM ranked WHERE rank = 1`)
            .all(JSON.stringify(requests))
      ).map((value) => {
        const row = record(value);
        return [validated(evidenceText(row.request_key), 'Desktop request key'), row] as const;
      }),
    );
  const desktops = readDesktops([...desktopRequests.values()]);
  for (const [key, rows] of nativeRoots) {
    if ((roots.get(key)?.length ?? 0) === 0 && rows.length === 1 && rows[0]) {
      desktops.set(key, rows[0]);
    }
  }
  const childRequests = scopes.flatMap((scope) =>
    scope.links.flatMap((link) => {
      const request = sessionRequests.get(link.key);
      const rootCount = roots.get(link.key)?.length ?? 0;
      const hasRoot = rootCount === 1 || (rootCount === 0 && nativeRoots.get(link.key)?.length === 1);
      return link.detachedAt === null && link.kind === 'session' && request && hasRoot
        ? [
            [
              JSON.stringify([link.threadId, link.key]),
              ...request.slice(1),
              desktops.get(link.key)?.desktop_session_id ?? null,
              link.threadId,
              JSON.stringify(
                request[2] === 'claude'
                  ? readWorkSessionDelegations(roots.get(link.key)?.[0]?.delegated_sessions).delegatedSessions
                  : [],
              ),
            ],
          ]
        : [];
    }),
  );
  const desktopChildFilter = childRequests.some((request) => request[4] !== null)
    ? `OR (machine_id, json_extract(source_row_json, '$.source.harnessKey'),
        json_extract(source_row_json, '$.source.sourceSessionId')) IN (
        SELECT requested.machine, requested.harness, desktop.cli_session_id
        FROM requested JOIN claude_desktop_sessions desktop
          ON desktop.machine_id = requested.machine AND desktop.spawned_from_session_id = requested.desktop_id
        WHERE requested.desktop_id IS NOT NULL
      )`
    : '';
  const delegatedChildFilter = `OR (machine_id, json_extract(source_row_json, '$.source.harnessKey'),
      json_extract(source_row_json, '$.source.sourceSessionId')) IN (
      SELECT requested.machine, 'codex', json_extract(delegation.value, '$.sourceSessionId')
      FROM requested JOIN json_each(requested.delegated_sessions) delegation
    )`;
  const children = groupEvidenceRecords(
    childRequests.length === 0
      ? []
      : db
          .query(`WITH requested AS MATERIALIZED (
      SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
        json_extract(value, '$[2]') AS harness, json_extract(value, '$[3]') AS session_id,
        json_extract(value, '$[4]') AS desktop_id, json_extract(value, '$[5]') AS thread_id,
        json_extract(value, '$[6]') AS delegated_sessions FROM json_each(?)
    ), ${memberCte(`${requestedIdentityFilter('parentSourceSessionId')} ${desktopChildFilter} ${delegatedChildFilter}`)}, candidates AS (
      SELECT requested.request_key, requested.thread_id, members.*
      FROM requested JOIN members ON machine_id = machine AND harness_key = harness AND parent_session_id = session_id
      UNION
      SELECT DISTINCT requested.request_key, requested.thread_id, members.*
      FROM requested JOIN claude_desktop_sessions desktop
        ON desktop.machine_id = machine AND desktop.spawned_from_session_id = desktop_id
      JOIN members ON members.machine_id = machine AND harness_key = harness
        AND source_session_id = desktop.cli_session_id AND parent_session_id IS NULL
      WHERE desktop_id IS NOT NULL
      UNION
      SELECT requested.request_key, requested.thread_id, members.*
      FROM requested JOIN json_each(requested.delegated_sessions) delegation
      LEFT JOIN members ON members.machine_id = requested.machine AND members.harness_key = 'codex'
        AND members.source_session_id = json_extract(delegation.value, '$.sourceSessionId')
      WHERE ${nonDetachedSessionSql('requested.machine', "'codex'", "json_extract(delegation.value, '$.sourceSessionId')")}
    ), ranked AS (
      SELECT requested.*,
        COUNT(*) OVER (PARTITION BY requested.request_key, machine_id, harness_key, source_session_id) AS identity_count,
        ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY active_time DESC, ordinal) AS rank
      FROM candidates requested
      WHERE ${nonDetachedSessionSql('requested.machine_id', 'requested.harness_key', 'requested.source_session_id')}
    ) SELECT ranked.*, ${EVIDENCE_MEMBER_DETAILS} FROM ranked
      LEFT JOIN served_report_rows metadata ON metadata.revision = ? AND metadata.ordinal = ranked.ordinal
      WHERE rank <= ? ORDER BY request_key, rank`)
          .all(JSON.stringify(childRequests), revision, revision, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren + 1),
  );
  const childDesktopRequests = new Map<string, readonly string[]>();
  for (const rows of children.values()) {
    for (const row of rows.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
      if (row.harness_key === 'claude') {
        const machine = validated(evidenceText(row.machine_id, 512), 'child machine');
        const sessionId = validated(evidenceText(row.source_session_id, 512), 'child session identity');
        const key = sessionEvidenceKey(machine, 'claude', sessionId);
        if (!desktopRequests.has(key)) {
          childDesktopRequests.set(key, [key, machine, 'claude', sessionId]);
        }
      }
    }
  }
  for (const [key, value] of readDesktops([...childDesktopRequests.values()])) {
    desktops.set(key, value);
  }
  const branches = groupEvidenceRecords(
    branchRequests.size === 0
      ? []
      : db
          .query(`WITH requested AS MATERIALIZED (
      SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
        json_extract(value, '$[2]') AS host, json_extract(value, '$[3]') AS repository,
        json_extract(value, '$[4]') AS ref, json_extract(value, '$[5]') AS thread_id FROM json_each(?)
    ), paths AS (
      SELECT DISTINCT requested.request_key, json_extract(source_row_json, '$.source.sourcePath') AS checkout_path
      FROM requested JOIN served_report_rows ON machine_id = machine AND revision = ?
        AND lower(json_extract(source_row_json, '$.source.vcs.repository.host')) = host
        AND lower(json_extract(source_row_json, '$.source.vcs.repository.ownerPath')) = repository
        AND json_extract(source_row_json, '$.source.vcs.branches[#-1].name') = ref
        AND json_extract(source_row_json, '$.source.sourcePath') IS NOT NULL
        AND ${nonDetachedSessionSql('machine_id', "json_extract(source_row_json, '$.source.harnessKey')", "json_extract(source_row_json, '$.source.sourceSessionId')")}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY request_key ORDER BY checkout_path) AS rank FROM paths
    ) SELECT * FROM ranked WHERE rank <= ? ORDER BY request_key, rank`)
          .all(JSON.stringify([...branchRequests.values()]), revision, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren + 1),
  );
  return { revision, generatedAt, roots, children, desktops, branches, nativeRoots };
};

const readThreadSessionEvidence = (
  page: SessionEvidencePage,
  input: Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'>,
): Omit<WorkThreadSessionEvidence, 'branchSessionLinks'> => {
  const { revision, generatedAt } = page;
  const sessions = new Map<string, WorkThreadSessionEvidence['sessions'][number]>();
  const branchCheckouts: WorkThreadSessionEvidence['branchCheckouts'][number][] = [];
  let truncated = false;
  const desktopOf = (machineId: string, sessionId: string, native?: Record<string, unknown>) => {
    const desktop = native ?? page.desktops.get(sessionEvidenceKey(machineId, 'claude', sessionId));
    if (desktop === undefined) {
      return null;
    }
    const value = record(desktop);
    return {
      desktopSessionId: validated(evidenceText(value.desktop_session_id, 512), 'Desktop session identity'),
      value: {
        cliSessionId: validated(evidenceText(value.cli_session_id, 512), 'Desktop current CLI identity'),
        desktopSessionId: validated(evidenceText(value.desktop_session_id, 512), 'Desktop session identity'),
        archived: value.archived === 1,
        format: validated(evidenceText(value.format), 'Desktop format'),
        branch: evidenceOptionalText(value.branch),
        createdAt: validated(normalizeIsoTimestamp(value.created_at), 'Desktop start instant'),
        cwd: validated(evidenceText(value.cwd), 'Desktop checkout'),
        lastActivityAt: validated(normalizeIsoTimestamp(value.last_activity_at), 'Desktop activity'),
        lastTurnReport: evidenceOptionalText(value.last_turn_report, 16_000),
        observedAt: validated(normalizeIsoTimestamp(value.observed_at), 'Desktop observation instant'),
        title: validated(evidenceText(value.title), 'Desktop title'),
        turnSummary:
          value.status_category === null
            ? null
            : {
                needsAction: evidenceOptionalText(value.needs_action),
                detail: validated(evidenceText(value.status_detail), 'Desktop turn summary'),
              },
        worktreePath: evidenceOptionalText(value.worktree_path),
      },
    };
  };
  const add = (raw: unknown, harness: string, declaredParent?: string) => {
    const row = record(raw);
    const machineId = validated(evidenceText(row.machine_id, 512), 'session machine');
    const sourceSessionId = validated(evidenceText(row.source_session_id, 512), 'session identity');
    const desktop = harness === 'claude' ? desktopOf(machineId, sourceSessionId) : null;
    const startedAt =
      row.started_at === null ? null : validated(normalizeIsoTimestamp(row.started_at), 'session start instant');
    // `active_time` falls back to the start date; an absent end is not a known span.
    const activeAt =
      row.ended_at === null ? null : Date.parse(validated(normalizeIsoTimestamp(row.ended_at), 'session end instant'));
    const delegations = readWorkSessionDelegations(row.delegated_sessions);
    truncated ||= delegations.delegatedSessionsTruncated;
    const entry = {
      harness,
      firstPrompt:
        row.title_source === 'first-prompt' ? validated(evidenceText(row.title), 'first prompt excerpt') : null,
      desktop: desktop?.value ?? null,
      member: {
        ...delegations,
        activeAt,
        branch: evidenceOptionalText(row.branch),
        campaignRoot: row.campaign_root === 1,
        checkoutPath: evidenceOptionalText(row.checkout_path),
        durationMs:
          typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms) && row.duration_ms >= 0
            ? row.duration_ms
            : null,
        machineId,
        origin: evidenceOptionalText(row.origin, 64),
        parentSourceSessionId:
          evidenceOptionalText(row.parent_session_id, 512) ??
          declaredParent ??
          sessions.get(JSON.stringify([machineId, harness, sourceSessionId]))?.member.parentSourceSessionId ??
          null,
        projectLabel: validated(evidenceText(row.project_label), 'session project'),
        rowId: validated(evidenceText(row.row_id, 512), 'session row'),
        sourceSessionId,
        startedAt,
        title: validated(evidenceText(row.title), 'session title'),
      },
    };
    sessions.set(JSON.stringify([machineId, harness, sourceSessionId]), entry);
    return desktop?.desktopSessionId ?? null;
  };
  for (const link of input.links.filter((item) => item.detachedAt === null)) {
    const parsed = parseWorkThreadLinkKey(link.kind, link.key);
    if (parsed?.kind === 'session') {
      const roots = page.roots.get(link.key) ?? [];
      const native = page.nativeRoots.get(link.key) ?? [];
      if (roots.length === 0 && native.length === 1 && parsed.harness === 'claude') {
        const desktop = desktopOf(parsed.machineId, parsed.sessionId, native[0]);
        if (desktop === null) {
          return invalidInput('Native Desktop evidence is missing');
        }
        sessions.set(JSON.stringify([parsed.machineId, parsed.harness, parsed.sessionId]), {
          harness: 'claude',
          firstPrompt: null,
          desktop: desktop.value,
          member: {
            activeAt: Date.parse(desktop.value.lastActivityAt),
            branch: evidenceOptionalText(native[0]?.branch),
            campaignRoot: false,
            checkoutPath: desktop.value.worktreePath ?? desktop.value.cwd,
            durationMs: null,
            delegatedSessions: [],
            delegatedSessionsTruncated: false,
            machineId: parsed.machineId,
            origin: null,
            parentSourceSessionId: null,
            projectLabel: null,
            rowId: null,
            sourceSessionId: parsed.sessionId,
            startedAt: desktop.value.createdAt,
            title: desktop.value.title,
          },
        });
      } else if (roots.length === 1) {
        add(roots[0], parsed.harness);
      } else {
        truncated = true;
        continue;
      }
      const children = page.children.get(JSON.stringify([link.threadId, link.key])) ?? [];
      if (children.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren) {
        truncated = true;
      }
      for (const child of children.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
        if (child.ordinal === null || child.identity_count !== 1) {
          truncated = true;
          continue;
        }
        const childHarness = validated(evidenceText(child.harness_key, 512), 'child harness');
        add(child, childHarness, childHarness === parsed.harness ? parsed.sessionId : undefined);
      }
    } else if (parsed?.kind === 'branch') {
      const paths = page.branches.get(JSON.stringify([link.threadId, input.machineId, link.key])) ?? [];
      if (paths.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren) {
        truncated = true;
      }
      for (const value of paths.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
        branchCheckouts.push({
          key: link.key,
          machineId: input.machineId,
          checkoutPath: validated(evidenceText(record(value).checkout_path), 'branch checkout'),
        });
      }
    }
  }
  return { revision, generatedAt, sessions: [...sessions.values()], branchCheckouts, truncated };
};

/** Adds the sessions the scope reads through its branch links, as links of the same thread. */
const withBranchSessions = <Scope extends Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'>>(
  db: SqliteDatabase,
  scope: Scope,
  threadId: string,
): Scope & { readonly branchLinks: readonly WorkThreadLink[]; readonly branchTruncated: boolean } => {
  if (scope.links.length > WORK_THREAD_BOUNDS.maxLinksPerThread) {
    return invalidInput('Invalid linked session evidence scope');
  }
  const branch = branchSessionLinks(db, { ...scope, threadId });
  return {
    ...scope,
    links: [...scope.links, ...branch.links],
    branchLinks: branch.links,
    branchTruncated: branch.truncated,
  };
};

const withBranchEvidence = (
  evidence: Omit<WorkThreadSessionEvidence, 'branchSessionLinks'>,
  scope: { readonly branchLinks: readonly WorkThreadLink[]; readonly branchTruncated: boolean },
): WorkThreadSessionEvidence => {
  // A derived session the read could not resolve to one served row is not shown as linked.
  const resolved = new Set(
    evidence.sessions.map((session) =>
      sessionEvidenceKey(session.member.machineId, session.harness, session.member.sourceSessionId),
    ),
  );
  return {
    ...evidence,
    branchSessionLinks: scope.branchLinks.filter((link) => resolved.has(link.key)),
    truncated: evidence.truncated || scope.branchTruncated,
  };
};

export const createWorkThreadSessionEvidenceStore = (dependencies: WorkThreadStoreDependencies) => {
  function queryWorkThreadSessionEvidence(
    input: QueryWorkThreadSessionEvidenceInput,
  ): Effect.Effect<WorkThreadSessionEvidence, UsageStoreError>;
  function queryWorkThreadSessionEvidence(
    input: QueryWorkThreadSessionEvidenceBatchInput,
  ): Effect.Effect<readonly WorkThreadSessionEvidenceBatchEntry[], UsageStoreError>;
  function queryWorkThreadSessionEvidence(
    input: QueryWorkThreadSessionEvidenceInput | QueryWorkThreadSessionEvidenceBatchInput,
  ): Effect.Effect<WorkThreadSessionEvidence | readonly WorkThreadSessionEvidenceBatchEntry[], UsageStoreError> {
    return dependencies.withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          db.exec('BEGIN');
          try {
            if ('threads' in input) {
              if (
                input.threads.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize ||
                new Set(input.threads.map((thread) => thread.threadId)).size !== input.threads.length ||
                input.threads.some(
                  (thread) =>
                    !isWorkThreadId(thread.threadId) || thread.links.some((link) => link.threadId !== thread.threadId),
                )
              ) {
                return invalidInput('Invalid work thread session evidence batch');
              }
              if (input.threads.length === 0) {
                return [];
              }
              const scopes = input.threads.map((thread) => withBranchSessions(db, thread, thread.threadId));
              const page = readSessionEvidencePage(db, scopes);
              return scopes.map((thread) => ({
                threadId: thread.threadId,
                evidence: withBranchEvidence(readThreadSessionEvidence(page, thread), thread),
              }));
            }
            const threadId = input.links[0]?.threadId;
            const scope =
              threadId === undefined
                ? { ...input, branchLinks: [], branchTruncated: false }
                : withBranchSessions(db, input, threadId);
            return withBranchEvidence(readThreadSessionEvidence(readSessionEvidencePage(db, [scope]), scope), scope);
          } finally {
            db.exec('COMMIT');
          }
        },
        catch: (cause) => dependencies.usageStoreReadError('queryWorkThreadSessionEvidence', input.dbPath, cause),
      }),
    );
  }
  return { queryWorkThreadSessionEvidence };
};
