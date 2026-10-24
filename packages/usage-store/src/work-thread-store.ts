import { randomUUID } from 'node:crypto';
import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  isWorkThreadId,
  parseWorkThread,
  parseWorkThreadCommand,
  parseWorkThreadEvent,
  parseWorkThreadLink,
  parseWorkThreadLinkKey,
  WORK_THREAD_BOUNDS,
  WORK_THREAD_COMMAND_FAILURES,
  type WorkThread,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
  type WorkThreadEvent,
  type WorkThreadIntent,
  type WorkThreadLink,
  type WorkThreadLinkKind,
} from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_VIEW_BOUNDS, type WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';

/** Operator-owned state, outside served revisions, collection generations and the outbox. */
export const WORK_THREAD_TABLES = [
  'work_threads',
  'work_thread_links',
  'work_thread_events',
  'work_thread_commands',
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
`;

interface SqliteDatabase {
  exec(sql: string): unknown;
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
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
  readonly discoveredAt: string;
  readonly intent: WorkThreadIntent | null;
  readonly linkKind: WorkThreadLinkKind;
  readonly origin: 'pull-request' | 'jira-issue' | 'session';
  readonly originKey: string;
  readonly projectLabel: string | null;
  readonly title: string;
}

export interface SeedWorkThreadsInput {
  readonly dbPath: string;
  readonly machineId: string;
  readonly now: string;
  readonly seeds: readonly WorkThreadSeed[];
}

export interface SeedWorkThreadsResult {
  readonly created: number;
  readonly existing: number;
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
      originKey: row.origin_key,
      projectLabel: row.project_label,
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
      key: row.link_key,
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
    parseWorkThreadLink({ ...link, detachedAt: null, linkId: randomUUID() }),
    'link write',
  );
  db.query(`INSERT INTO work_thread_links(link_id, thread_id, kind, link_key, provenance, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    validatedLink.linkId,
    link.threadId,
    link.kind,
    link.key,
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

const replayResult = (value: unknown): WorkThreadCommandResult => {
  const result = record(json(record(value).result_json));
  if (
    result.ok === true &&
    typeof result.applied === 'boolean' &&
    isWorkThreadId(result.threadId) &&
    typeof result.followRevision === 'number' &&
    Number.isSafeInteger(result.followRevision) &&
    result.followRevision >= 1
  ) {
    return { applied: false, followRevision: result.followRevision, ok: true, threadId: result.threadId };
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
        'SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = ? AND link_key = ? AND detached_at IS NULL',
      )
      .get(thread.threadId, command.kind, command.key) !== null
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

const executeCommand = (
  db: SqliteDatabase,
  input: ApplyWorkThreadCommandInput,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  const command = parseWorkThreadCommand(input.command);
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
      const identity = JSON.stringify([link.kind, link.key]);
      if (!seen.has(identity)) {
        addLink(db, { ...link, createdAt: now, provenance: 'user', threadId: thread.threadId });
        seen.add(identity);
      }
    }
    addEvent(db, thread, now, 'created', { toState: 'following' });
    return success(thread);
  }
  const thread = readThread(db, command.threadId);
  if (!thread) {
    return failure('not-found', 'The work thread was not found');
  }
  switch (command.op) {
    case 'set-follow-state':
      return applyFollowState(db, thread, command, now);
    case 'link':
      return applyLink(db, thread, command, now);
    case 'detach-link': {
      const row = db
        .query('SELECT * FROM work_thread_links WHERE thread_id = ? AND link_id = ?')
        .get(thread.threadId, command.linkId);
      if (row === null) {
        return failure('invalid-link', 'The link does not belong to this thread', thread.followRevision);
      }
      const link = linkFromRecord(row);
      if (link.detachedAt !== null) {
        return success(thread, false);
      }
      db.query('UPDATE work_thread_links SET detached_at = ? WHERE link_id = ?').run(now, link.linkId);
      saveThread(db, { ...thread, updatedAt: now });
      addEvent(db, thread, now, 'link-detached', { linkKey: link.key });
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
  const conditions = [query.tab === 'done' ? "t.follow_state = 'done'" : "t.follow_state IN ('following', 'waiting')"];
  const params: unknown[] = [];
  if (query.project !== null) {
    conditions.push('t.project_label = ?');
    params.push(query.project);
  }
  if (query.search !== null && query.search.length > 0) {
    conditions.push(`(instr(lower(t.title), lower(?)) > 0 OR EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id = t.thread_id AND l.detached_at IS NULL AND instr(lower(l.link_key), lower(?)) > 0
    ))`);
    params.push(query.search, query.search);
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
    conditions.push('(t.last_activity_at < ? OR (t.last_activity_at = ? AND t.thread_id > ?))');
    params.push(cursor.at, cursor.at, cursor.threadId);
  }
  return { params, sql: conditions.join(' AND ') };
};

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

  const applyWorkThreadCommand = (
    input: ApplyWorkThreadCommandInput,
  ): Effect.Effect<WorkThreadCommandResult, UsageStoreError> =>
    write(input.dbPath, 'applyWorkThreadCommand', (db) => {
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

  const seedWorkThreads = (input: SeedWorkThreadsInput): Effect.Effect<SeedWorkThreadsResult, UsageStoreError> =>
    write(input.dbPath, 'seedWorkThreads', (db) => {
      const now = instant(input.now);
      let created = 0;
      let existing = 0;
      for (const seed of input.seeds) {
        if (seed.origin !== seed.linkKind || !parseWorkThreadLinkKey(seed.linkKind, seed.originKey)) {
          return invalidInput('Seed origin and qualified link key must match');
        }
        if (db.query('SELECT 1 FROM work_threads WHERE origin_key = ?').get(seed.originKey) !== null) {
          existing++;
          continue;
        }
        const discoveredAt = instant(seed.discoveredAt);
        const thread = newThread({ ...seed, machineId: input.machineId, now: discoveredAt, objective: null });
        saveThread(db, { ...thread, updatedAt: now });
        addLink(db, {
          createdAt: discoveredAt,
          key: seed.originKey,
          kind: seed.linkKind,
          provenance: 'origin',
          threadId: thread.threadId,
        });
        addEvent(db, thread, discoveredAt, 'created', { toState: 'following' });
        created++;
      }
      return { created, existing };
    });

  const queryWorkThreadsPage = (
    input: QueryWorkThreadsPageInput,
  ): Effect.Effect<QueryWorkThreadsPageResult, UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadsPage', (db) => {
      const { sql, params } = pageFilter(input.query);
      const records = db
        .query(`SELECT t.* FROM work_threads t WHERE ${sql}
        ORDER BY t.last_activity_at DESC, t.thread_id ASC LIMIT ?`)
        .all(...params, input.query.limit + 1);
      const rows = records.slice(0, input.query.limit).map(
        (value): WorkThreadPageRow => ({
          lastActivityAt: parseCanonicalInstant(record(value).last_activity_at),
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
    read(input.dbPath, 'queryWorkThreadById', (db) => readThread(db, input.threadId));

  const queryWorkThreadLinks = (
    input: QueryWorkThreadLinksInput,
  ): Effect.Effect<readonly WorkThreadLink[], UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadLinks', (db) => {
      const ids = [...new Set(input.threadIds)];
      if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
        return invalidInput('Invalid work thread link scope');
      }
      // Active links are all returned; detached history is the latest maxEventsPerThread per thread.
      return ids.flatMap((id) =>
        db
          .query(`SELECT * FROM (
        SELECT * FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL
        UNION ALL SELECT * FROM (
          SELECT * FROM work_thread_links WHERE thread_id = ? AND detached_at IS NOT NULL
          ORDER BY detached_at DESC, rowid DESC LIMIT ?
        )
      ) ORDER BY created_at, link_id`)
          .all(id, id, WORK_THREAD_BOUNDS.maxEventsPerThread)
          .map(linkFromRecord),
      );
    });

  const queryWorkThreadEvents = (
    input: QueryWorkThreadByIdInput,
  ): Effect.Effect<readonly WorkThreadEvent[], UsageStoreError> =>
    read(input.dbPath, 'queryWorkThreadEvents', (db) =>
      db
        .query(`SELECT event_json FROM (
      SELECT event_json, at, rowid AS sequence FROM work_thread_events WHERE thread_id = ?
      ORDER BY at DESC, rowid DESC LIMIT ?
    ) ORDER BY at, sequence`)
        .all(input.threadId, WORK_THREAD_BOUNDS.maxEventsPerThread)
        .map((value) => validated(parseWorkThreadEvent(json(record(value).event_json)), 'event')),
    );

  const countWorkThreads = (input: {
    readonly dbPath: string;
  }): Effect.Effect<{ readonly done: number; readonly open: number }, UsageStoreError> =>
    read(input.dbPath, 'countWorkThreads', (db) => {
      const row = record(
        db
          .query(`SELECT COUNT(CASE WHEN follow_state = 'done' THEN 1 END) AS done,
        COUNT(CASE WHEN follow_state IN ('following', 'waiting') THEN 1 END) AS open FROM work_threads`)
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
        .query(`SELECT DISTINCT project_label FROM work_threads
      WHERE project_label IS NOT NULL ORDER BY project_label LIMIT ?`)
        .all(WORK_THREAD_VIEW_BOUNDS.maxProjects)
        .map((value) =>
          validated(
            typeof record(value).project_label === 'string' ? String(record(value).project_label) : null,
            'project',
          ),
        ),
    );

  return {
    ...createWorkThreadSessionEvidenceStore(dependencies),
    applyWorkThreadCommand,
    countWorkThreads,
    queryWorkThreadById,
    queryWorkThreadEvents,
    queryWorkThreadLinks,
    queryWorkThreadProjects,
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
  readonly generatedAt: CanonicalInstant | null;
  readonly revision: string | null;
  readonly sessions: readonly {
    readonly harness: string;
    /** Stored first-prompt excerpt only when the served row declares that title provenance. */
    readonly firstPrompt: string | null;
    readonly member: import('./work-session-join').ServedHarnessSessionMember;
    readonly desktop: {
      readonly createdAt: CanonicalInstant;
      readonly cwd: string;
      readonly lastActivityAt: CanonicalInstant;
      readonly lastTurnReport: string | null;
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

const EVIDENCE_MEMBER_COLUMNS = `row_id, machine_id, project_label, campaign_root, origin, active_time,
  json_extract(source_row_json, '$.source.sourceSessionId') AS source_session_id,
  json_extract(source_row_json, '$.source.parentSourceSessionId') AS parent_session_id,
  json_extract(source_row_json, '$.source.sourcePath') AS checkout_path,
  json_extract(source_row_json, '$.source.vcs.branches[#-1].name') AS branch,
  json_extract(source_row_json, '$.date') AS started_at,
  json_extract(source_row_json, '$.endDate') AS ended_at,
  json_extract(source_row_json, '$.sessionLabel') AS title,
  json_extract(source_row_json, '$.titleSource') AS title_source`;

const evidenceText = (value: unknown, maximum = 4096): string | null =>
  typeof value === 'string' && value.length <= maximum ? value : null;
const evidenceOptionalText = (value: unknown, maximum = 4096): string | null =>
  value === null || value === undefined ? null : validated(evidenceText(value, maximum), 'session metadata');

const readThreadSessionEvidence = (
  db: SqliteDatabase,
  input: QueryWorkThreadSessionEvidenceInput,
): WorkThreadSessionEvidence => {
  if (
    input.links.length > WORK_THREAD_BOUNDS.maxLinksPerThread ||
    !input.machineId ||
    input.links.some((link) => parseWorkThreadLink(link) === null)
  ) {
    return invalidInput('Invalid linked session evidence scope');
  }
  const currentValue = db
    .query(`SELECT revisions.revision, revisions.generated_at FROM served_report_current current
    JOIN served_report_revisions revisions USING(revision) WHERE current.singleton = 1 AND revisions.complete = 1`)
    .get();
  if (currentValue === null) {
    return { revision: null, generatedAt: null, sessions: [], branchCheckouts: [], truncated: false };
  }
  const current = record(currentValue);
  const revision = validated(evidenceText(current.revision, 512), 'served revision');
  const generatedAt = validated(normalizeIsoTimestamp(current.generated_at), 'served revision date');
  const sessions = new Map<string, WorkThreadSessionEvidence['sessions'][number]>();
  const branchCheckouts: WorkThreadSessionEvidence['branchCheckouts'][number][] = [];
  let truncated = false;
  const desktopOf = (machineId: string, sessionId: string) => {
    const desktop = db
      .query(`SELECT * FROM claude_desktop_sessions WHERE machine_id = ? AND
      (cli_session_id = ? OR EXISTS (SELECT 1 FROM json_each(prior_cli_session_ids_json) WHERE value = ?))
      ORDER BY last_activity_at DESC, id DESC LIMIT 1`)
      .get(machineId, sessionId, sessionId);
    if (desktop === null) {
      return null;
    }
    const value = record(desktop);
    return {
      desktopSessionId: validated(evidenceText(value.desktop_session_id, 512), 'Desktop session identity'),
      value: {
        createdAt: validated(normalizeIsoTimestamp(value.created_at), 'Desktop start instant'),
        cwd: validated(evidenceText(value.cwd), 'Desktop checkout'),
        lastActivityAt: validated(normalizeIsoTimestamp(value.last_activity_at), 'Desktop activity'),
        lastTurnReport: evidenceOptionalText(value.last_turn_report, 16_000),
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
    const entry = {
      harness,
      firstPrompt:
        row.title_source === 'first-prompt' ? validated(evidenceText(row.title), 'first prompt excerpt') : null,
      desktop: desktop?.value ?? null,
      member: {
        activeAt,
        branch: evidenceOptionalText(row.branch),
        campaignRoot: row.campaign_root === 1,
        checkoutPath: evidenceOptionalText(row.checkout_path),
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
      const roots = db
        .query(`SELECT ${EVIDENCE_MEMBER_COLUMNS} FROM served_report_rows WHERE revision = ? AND machine_id = ?
        AND json_extract(source_row_json, '$.source.harnessKey') = ? AND json_extract(source_row_json, '$.source.sourceSessionId') = ? ORDER BY ordinal LIMIT 2`)
        .all(revision, parsed.machineId, parsed.harness, parsed.sessionId);
      if (roots.length !== 1) {
        truncated = true;
        continue;
      }
      const root = roots[0];
      const desktopId = add(root, parsed.harness);
      const children = db
        .query(`SELECT ${EVIDENCE_MEMBER_COLUMNS} FROM served_report_rows WHERE revision = ? AND machine_id = ?
        AND json_extract(source_row_json, '$.source.harnessKey') = ? AND (
          json_extract(source_row_json, '$.source.parentSourceSessionId') = ? OR
          (? IS NOT NULL AND json_extract(source_row_json, '$.source.parentSourceSessionId') IS NULL AND json_extract(source_row_json, '$.source.sourceSessionId') IN (
            SELECT cli_session_id FROM claude_desktop_sessions WHERE machine_id = ? AND spawned_from_session_id = ?)))
        ORDER BY active_time DESC, ordinal LIMIT ?`)
        .all(
          revision,
          parsed.machineId,
          parsed.harness,
          parsed.sessionId,
          desktopId,
          parsed.machineId,
          desktopId,
          WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren + 1,
        );
      if (children.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren) {
        truncated = true;
      }
      for (const child of children.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
        add(child, parsed.harness, parsed.sessionId);
      }
    } else if (parsed?.kind === 'branch') {
      const paths = db
        .query(`SELECT DISTINCT json_extract(source_row_json, '$.source.sourcePath') AS checkout_path
        FROM served_report_rows WHERE revision = ? AND machine_id = ?
        AND lower(json_extract(source_row_json, '$.source.vcs.repository.host')) = ?
        AND json_extract(source_row_json, '$.source.vcs.repository.ownerPath') = ?
        AND json_extract(source_row_json, '$.source.vcs.branches[#-1].name') = ?
        AND json_extract(source_row_json, '$.source.sourcePath') IS NOT NULL ORDER BY checkout_path LIMIT ?`)
        .all(
          revision,
          input.machineId,
          parsed.host,
          parsed.repository,
          parsed.ref,
          WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren + 1,
        );
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

export const createWorkThreadSessionEvidenceStore = (dependencies: WorkThreadStoreDependencies) => ({
  queryWorkThreadSessionEvidence: (
    input: QueryWorkThreadSessionEvidenceInput,
  ): Effect.Effect<WorkThreadSessionEvidence, UsageStoreError> =>
    dependencies.withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          db.exec('BEGIN');
          try {
            return readThreadSessionEvidence(db, input);
          } finally {
            db.exec('COMMIT');
          }
        },
        catch: (cause) => dependencies.usageStoreReadError('queryWorkThreadSessionEvidence', input.dbPath, cause),
      }),
    ),
});
