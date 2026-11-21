import { randomUUID } from 'node:crypto';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  parseWorkThread,
  parseWorkThreadEvent,
  parseWorkThreadLink,
  type WorkThread,
  type WorkThreadEvent,
  type WorkThreadIntent,
  type WorkThreadLink,
  type WorkThreadLinkKind,
  type WorkThreadWait,
} from '@ai-usage/report-core/work-thread';
import { Effect } from 'effect';
import { withUsageStoreReader, withUsageStoreWriter } from './connections';
import { UsageStoreError, usageStoreError, usageStoreReadError } from './errors';
import { WORK_THREAD_TABLES } from './work-thread-schema';

export interface SqliteDatabase {
  exec: (sql: string) => unknown;
  query: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
  };
}

/** Repository authorities are case-insensitive; Git branch refs remain case-sensitive. */
export const canonicalLinkKey = (kind: WorkThreadLinkKind, key: string): string => {
  if (kind === 'pull-request') {
    return key.toLowerCase();
  }
  if (kind === 'branch') {
    const boundary = key.indexOf('@');
    return boundary < 0 ? key : key.slice(0, boundary).toLowerCase() + key.slice(boundary);
  }
  return key;
};

export const comparableLinkSql = (kind: WorkThreadLinkKind): string => {
  if (kind === 'pull-request') {
    return 'lower(link_key)';
  }
  if (kind === 'branch') {
    return "lower(substr(link_key, 1, instr(link_key, '@') - 1)) || substr(link_key, instr(link_key, '@'))";
  }
  return 'link_key';
};

export const invalidInput = (message: string): never => {
  throw new UsageStoreError({ message, operation: 'work-thread', reason: 'invalid-input' });
};

export const instant = (value: string): CanonicalInstant =>
  normalizeIsoTimestamp(value) ?? invalidInput('Work thread timestamp must be an ISO instant');

export const validated = <Value>(value: Value | null, label: string): Value => {
  if (value === null) {
    throw new UsageStoreError({
      message: `Invalid stored work thread ${label}`,
      operation: 'work-thread',
      reason: 'corrupt',
    });
  }
  return value;
};

export const record = (value: unknown): Record<string, unknown> => validated(isRecord(value) ? value : null, 'record');
export const json = (value: unknown): unknown =>
  JSON.parse(validated(typeof value === 'string' ? value : null, 'JSON'));

export const waitLinkKind = (kind: WorkThreadWait['kind']): 'pull-request' | 'jira-issue' =>
  kind === 'pull-request-review' ? 'pull-request' : 'jira-issue';

export const threadFromRecord = (value: unknown): WorkThread => {
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

export const linkFromRecord = (value: unknown): WorkThreadLink => {
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

export const readThread = (db: SqliteDatabase, threadId: string): WorkThread | null => {
  const row = db.query('SELECT * FROM work_threads WHERE thread_id = ?').get(threadId);
  return row === null ? null : threadFromRecord(row);
};

export const saveThread = (db: SqliteDatabase, thread: WorkThread): void => {
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

export const addEvent = (
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

export const addLink = (db: SqliteDatabase, link: Omit<WorkThreadLink, 'linkId' | 'detachedAt'>): void => {
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

export const newThread = (input: {
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
export const taskThreadsSql = (alias: string): string =>
  `(SELECT ${alias}.thread_id UNION ALL SELECT combination.member_thread_id FROM work_thread_combinations combination
    WHERE combination.kept_thread_id = ${alias}.thread_id AND combination.separated_at IS NULL)`;

/** True for a task combined into another (hidden from lists, read-only for commands). */
export const notCombinedMemberSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM work_thread_combinations combination
    WHERE combination.member_thread_id = ${alias}.thread_id AND combination.separated_at IS NULL)`;

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

export const hasKnownWorkThreadLink = (db: SqliteDatabase, kind: WorkThreadLinkKind, key: string): boolean =>
  db
    .query(`SELECT 1 FROM work_threads WHERE ${kind === 'pull-request' ? 'lower(origin_key)' : 'origin_key'} = ?`)
    .get(key) !== null ||
  db.query(`SELECT 1 FROM work_thread_links WHERE kind = ? AND ${comparableLinkSql(kind)} = ?`).get(kind, key) !== null;

export const activeLinkCount = (db: SqliteDatabase, threadId: string): number => {
  const count = record(
    db
      .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
      .get(threadId),
  ).count;
  return typeof count === 'number' ? count : Number.POSITIVE_INFINITY;
};

export const write = <Value>(
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
export const read = <Value>(
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

export const evidenceText = (value: unknown, maximum = 4096): string | null =>
  typeof value === 'string' && value.length <= maximum ? value : null;
