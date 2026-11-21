import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toSerializedMergeRow, usageContentHash } from '@ai-usage/report-core/merge-bundle';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { completeSkillObservationCollection } from '@ai-usage/report-core/skill-observation';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { initializeUsageStore, quiesceUsageStoreForShutdown } from './connections';
import { migrate } from './migration';
import { MAX_PROVIDER_QUOTA_STREAMS } from './provider-quota-store';
import { SERVED_REPORT_PROJECTION_SCHEMA_VERSION } from './served-revision';
import {
  createTrackedSqliteDatabase,
  type RawSqliteDatabase,
  type SqliteDatabase,
  type SqliteStatement,
} from './sqlite-database';
import {
  importClaudeDesktopSessions,
  importExecutorObservations,
  importLocalRows,
  importProviderQuotaBatch,
  importSkillObservations,
  updateUsageMachineLabel,
} from './writer';

// Characterization of `migrate()` (plan 128 A2): for a fresh store and every legacy shape the usage-store
// tests know how to build, the exact SQL `migrate()` sends and its order, its result or error, the
// resulting `sqlite_schema`, `user_version` and data are pinned in the snapshot file. A refactor of
// `migrate()` that is behaviour-preserving leaves every snapshot unchanged. The legacy shapes are
// rebuilt here from the builders in `migration.test.ts`, `index.test.ts`, `review-attempt-store.test.ts`,
// `work-fact-store.test.ts` and `codex-work-store.integration.test.ts`; test files cannot import each other.

const FROZEN_NOW = new Date('2026-11-01T12:00:00.000Z');
const FULL_ROW_LIMIT = 100;
const MACHINE = { id: 'characterization-machine', label: 'Characterization machine' };

const temporaryRoots: string[] = [];

const temporaryPath = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return path.join(root, 'usage-store.sqlite');
};

// ---------------------------------------------------------------------------------------------------------
// Recording: every SQL text `migrate()` passes to the handle, and every execution of a prepared statement.

const sqlKey = (sql: string): string => createHash('sha256').update(sql).digest('hex').slice(0, 16);

interface Recording {
  readonly events: string[];
  readonly texts: Map<string, string>;
}

const remember = (recording: Recording, sql: string): string => {
  const key = sqlKey(sql);
  recording.texts.set(key, sql);
  return key;
};

// An execution that directly follows the preparation of its own statement is folded into one
// `prepare+<operation>` event; the encoding stays lossless.
const recordingStatement = (statement: SqliteStatement, key: string, recording: Recording): SqliteStatement => {
  const record = (operation: string, params: unknown[]): void => {
    const event = `${operation} ${key} ${JSON.stringify(params)}`;
    if (recording.events.at(-1) === `prepare ${key}`) {
      recording.events[recording.events.length - 1] = `prepare+${event}`;
      return;
    }
    recording.events.push(event);
  };
  return {
    all: (...params) => {
      record('all', params);
      return statement.all(...params);
    },
    finalize: () => statement.finalize(),
    get: (...params) => {
      record('get', params);
      return statement.get(...params);
    },
    iterate: (...params) => {
      record('iterate', params);
      return statement.iterate(...params);
    },
    run: (...params) => {
      record('run', params);
      return statement.run(...params);
    },
  };
};

const recordingDatabase = (db: SqliteDatabase, recording: Recording): SqliteDatabase => ({
  clearStatements: () => db.clearStatements(),
  close: (throwOnError) => db.close(throwOnError),
  exec: (sql) => {
    recording.events.push(`exec ${remember(recording, sql)}`);
    return db.exec(sql);
  },
  get inTransaction() {
    return db.inTransaction;
  },
  query: (sql) => {
    const key = remember(recording, sql);
    recording.events.push(`prepare ${key}`);
    return recordingStatement(db.query(sql), key, recording);
  },
});

// ---------------------------------------------------------------------------------------------------------
// Capture of the store after a migration.

interface MigrationOutcome {
  readonly error?: { readonly className: string; readonly code: unknown; readonly message: string };
  readonly schemaChanged?: boolean;
}

const runMigrate = (db: SqliteDatabase, recording: Recording): MigrationOutcome => {
  try {
    return { schemaChanged: migrate(recordingDatabase(db, recording)) };
  } catch (cause) {
    if (!(cause instanceof Error)) {
      throw cause;
    }
    return {
      error: {
        code: 'code' in cause ? cause.code : null,
        className: cause.constructor.name,
        message: cause.message,
      },
    };
  }
};

interface SchemaRow {
  readonly name: string;
  readonly sql: string | null;
  readonly tbl_name: string;
  readonly type: string;
}

const readSchemaRows = (db: SqliteDatabase): SchemaRow[] =>
  db.query('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name, type').all() as SchemaRow[];

const describeSchema = (rows: readonly SchemaRow[], recording: Recording): string[] =>
  rows.map(
    ({ name, sql, tbl_name, type }) =>
      `${type} ${name} ON ${tbl_name} ${sql === null ? 'sql:null' : `sql:${remember(recording, sql)}`}`,
  );

// Every row of every table as sorted JSON lines; WITHOUT ROWID tables have no rowid to order by.
const readTableRows = (db: SqliteDatabase): Map<string, string[]> =>
  new Map(
    (
      db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map(({ name }) => [
      name,
      db
        .query(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );

const sameRows = (left: readonly string[] | undefined, right: readonly string[]): boolean =>
  left !== undefined && left.length === right.length && left.every((row, index) => row === right[index]);

interface DataCapture {
  // Row count of every table after the migration.
  readonly counts: Record<string, number>;
  // Tables that existed before the migration and no longer do.
  readonly droppedTables: string[];
  // Full rows of every table the migration created with rows or whose rows it changed.
  readonly rewritten: Record<string, string[] | string>;
}

const describeData = (before: Map<string, string[]>, after: Map<string, string[]>): DataCapture => ({
  counts: Object.fromEntries([...after].map(([table, rows]) => [table, rows.length])),
  droppedTables: [...before.keys()].filter((table) => !after.has(table)),
  rewritten: Object.fromEntries(
    [...after]
      .filter(([table, rows]) => !(sameRows(before.get(table), rows) || (rows.length === 0 && !before.has(table))))
      .map(([table, rows]) => [table, rows.length > FULL_ROW_LIMIT ? `${rows.length} rows` : rows]),
  ),
});

const readUserVersion = (db: SqliteDatabase): number =>
  (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;

// The same connection setup as the writer open in `connections.ts`, outside the recording.
const openLikeTheWriter = (dbPath: string): SqliteDatabase => {
  const db = createTrackedSqliteDatabase(new Database(dbPath) as unknown as RawSqliteDatabase);
  db.exec('PRAGMA busy_timeout = 5000');
  const journalMode = db.query('PRAGMA journal_mode').get() as { journal_mode?: unknown };
  if (journalMode.journal_mode !== 'wal') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -65536');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
};

// The no-op second run, shared by every shape that migrates, is stored once in the keyed text snapshot and
// referenced here by key. `schema` lists every `sqlite_schema` row, its SQL by key.
interface ShapeCapture {
  readonly afterSecondRun?: { readonly outcome: MigrationOutcome; readonly sqlKey: string };
  readonly data: DataCapture;
  readonly outcome: MigrationOutcome;
  readonly schema: string[];
  readonly sql: string[];
  readonly userVersion: number;
}

interface ShapeResult {
  readonly capture: ShapeCapture;
  readonly schemaAfterFirstRun: SchemaRow[];
  readonly schemaAfterSecondRun: SchemaRow[] | undefined;
  readonly texts: Map<string, string>;
}

const captureShape = (dbPath: string): ShapeResult => {
  const db = openLikeTheWriter(dbPath);
  try {
    const rowsBefore = readTableRows(db);
    const first: Recording = { events: [], texts: new Map() };
    const outcome = runMigrate(db, first);
    const schemaAfterFirstRun = readSchemaRows(db);
    const capture: ShapeCapture = {
      data: describeData(rowsBefore, readTableRows(db)),
      outcome,
      schema: describeSchema(schemaAfterFirstRun, first),
      sql: first.events,
      userVersion: readUserVersion(db),
    };
    if (outcome.error !== undefined) {
      return { capture, schemaAfterFirstRun, schemaAfterSecondRun: undefined, texts: first.texts };
    }
    // Idempotence: a second run on the migrated store reports no change and leaves the schema as it is.
    const second: Recording = { events: [], texts: first.texts };
    const secondOutcome = runMigrate(db, second);
    return {
      capture: {
        ...capture,
        afterSecondRun: { outcome: secondOutcome, sqlKey: remember(first, second.events.join('\n')) },
      },
      schemaAfterFirstRun,
      schemaAfterSecondRun: readSchemaRows(db),
      texts: first.texts,
    };
  } finally {
    db.close(true);
  }
};

// ---------------------------------------------------------------------------------------------------------
// Store shapes.

const withRawDatabase = (dbPath: string, use: (db: Database) => void): void => {
  const db = new Database(dbPath, { create: false, readwrite: true });
  try {
    use(db);
  } finally {
    db.close(true);
  }
};

const execOn =
  (sql: string) =>
  (dbPath: string): void =>
    withRawDatabase(dbPath, (db) => db.exec(sql));

const claudeRow = (): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-10-20T08:00:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-10-20T08:01:00.000Z'),
    harness: 'Claude Code',
    model: 'claude-sonnet-4-6',
    name: 'Characterization session',
    project: 'ai-usage',
    provider: 'Claude sub',
    tokens: { cr: 0, cw: 0, in: 10, out: 20 },
  }),
  source: {
    harnessKey: 'claude',
    sourcePath: '/home/alex/Projects/ai-usage',
    sourceSessionId: 'characterization-session',
  },
});

const codexRow = (sourceSessionId: string): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-06-01T10:00:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-06-01T10:01:00.000Z'),
    harness: 'Codex',
    model: 'gpt-5',
    name: 'Session',
    project: 'ai-usage',
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 5, in: 10, out: 20 },
  }),
  source: { harnessKey: 'codex', sourceSessionId },
});

const quotaObservation: ProviderQuotaObservation = {
  accountScope: null,
  machineId: MACHINE.id,
  machineLabel: MACHINE.label,
  observedAt: '2026-10-20T09:30:00.000Z',
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: 'poll', mode: 'poll' },
  state: 'ok',
  windows: [],
};

const executorObservation = (harness: string, observedAt: string, accountFingerprint?: string) => ({
  ...(accountFingerprint === undefined ? {} : { accountFingerprint }),
  authEvidence: `${harness} status exit 0`,
  authMethod: null,
  authState: 'logged-in',
  binaryPath: `/usr/bin/${harness}`,
  harness,
  machineId: MACHINE.id,
  observedAt,
  outcome: 'observed',
  version: '1.0.0',
});

const desktopSession = {
  accountDirectory: 'account',
  archived: false,
  cliSessionId: 'characterization-session',
  createdAt: '2026-10-01T08:00:00.000Z',
  cwd: '/home/fixture/work/project',
  desktopSessionId: 'local_characterization',
  fileModifiedAt: '2026-10-01T09:00:00.000Z',
  filePath: '.config/Claude/claude-code-sessions/account/org/local_characterization.json',
  format: 'claude-desktop-session-v1',
  lastActivityAt: '2026-10-01T09:00:00.000Z',
  machineId: MACHINE.id,
  observedAt: '2026-10-01T09:01:00.000Z',
  organizationDirectory: 'org',
  title: 'Characterization',
  titleSource: 'auto',
  turnSummary: { detail: 'Stopped.', needsAction: 'Which?', status: 'blocked', summarizesUuid: 'uuid-a' },
};

const populateThroughTheWriter = async (dbPath: string): Promise<void> => {
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: MACHINE }));
  await Effect.runPromise(importLocalRows({ dbPath, machine: MACHINE, rows: [claudeRow()] }));
  await Effect.runPromise(
    importSkillObservations({
      collection: { completeness: completeSkillObservationCollection(), harnessKey: 'claude' },
      dbPath,
      machineId: MACHINE.id,
      observations: [
        {
          argsPresent: null,
          harnessKey: 'claude',
          observationKey: 'call_characterization',
          observedAt: '2026-10-20T09:00:00.000Z',
          projectPath: null,
          resolvedPath: null,
          sessionId: 'characterization-session',
          skillName: 'write-a-skill',
          success: true,
          tier: 'declared',
        },
      ],
    }),
  );
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [{ observation: quotaObservation, sourceEventKey: 'event-characterization' }],
    }),
  );
  await Effect.runPromise(
    importExecutorObservations({
      dbPath,
      observations: [
        executorObservation('claude-code', '2026-10-25T08:00:00.000Z', '0123456789abcdef'),
        executorObservation('claude-code', '2026-10-25T09:00:00.000Z', 'fedcba9876543210'),
        executorObservation('codex', '2026-10-25T08:30:00.000Z'),
      ],
    }),
  );
  await Effect.runPromise(
    importClaudeDesktopSessions({
      completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
      dbPath,
      machineId: MACHINE.id,
      observations: [desktopSession],
    }),
  );
  execOn(`
    INSERT INTO served_report_revisions (
      revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
      usage_store_generation, machine_fleet_generation, projection_schema_version,
      generated_at, published_at, expires_at, complete, row_count, segment_count,
      filter_key_count, rows_bytes, support_bytes, projection_bytes
    ) VALUES (
      'characterization-revision', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${'c'.repeat(64)}',
      1, 1, ${SERVED_REPORT_PROJECTION_SCHEMA_VERSION}, '2026-10-20T10:00:00.000Z', 1000, 2000, 1, 0, 0, 0, 0, 0, 0
    );
    INSERT INTO served_report_current (singleton, revision, required_complete)
    VALUES (1, 'characterization-revision', 1);
  `)(dbPath);
  await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath }));
};

// Verbatim from `migration.test.ts`: the outbox objects schema 4 created and schema 5 drops.
const SCHEMA_FOUR_OUTBOX_SQL = `
  CREATE TABLE IF NOT EXISTS replication_outbox_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
    next_generation INTEGER NOT NULL CHECK (next_generation > 0),
    acknowledged_through_generation INTEGER NOT NULL DEFAULT 0
      CHECK (acknowledged_through_generation >= 0),
    previous_ack_proof TEXT CHECK (previous_ack_proof IS NULL OR length(previous_ack_proof) = 64),
    last_acknowledged_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS replication_outbox_events (
    event_id             TEXT PRIMARY KEY,
    generation           INTEGER NOT NULL CHECK (generation > 0),
    fact_key             TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 512),
    content_hash         TEXT NOT NULL CHECK (length(content_hash) = 64),
    change_kind          TEXT NOT NULL,
    payload              TEXT NOT NULL CHECK (json_valid(payload)),
    state                TEXT NOT NULL CHECK (
      state IN ('pending', 'in-flight', 'acknowledged', 'blocked')
    ),
    enqueued_at          TEXT NOT NULL,
    attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at      TEXT,
    last_error_code      TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
    acknowledged_at      TEXT,
    UNIQUE (generation, fact_key, content_hash),
    CHECK (
      (state = 'acknowledged' AND acknowledged_at IS NOT NULL)
      OR (state <> 'acknowledged' AND acknowledged_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_replication_outbox_ready
    ON replication_outbox_events(state, next_attempt_at, generation);
  CREATE INDEX IF NOT EXISTS idx_replication_outbox_fact_history
    ON replication_outbox_events(fact_key, generation);

  INSERT INTO replication_outbox_state (
    singleton, device_id, stream_id, next_generation, acknowledged_through_generation,
    previous_ack_proof, last_acknowledged_at, created_at, updated_at
  ) VALUES (
    1, 'schema-four-device', 'usage-v1', 3, 1, '${'d'.repeat(64)}',
    '2026-10-20T10:05:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:05:00.000Z'
  );
  INSERT INTO replication_outbox_events (
    event_id, generation, fact_key, content_hash, change_kind, payload, state,
    enqueued_at, attempt_count, next_attempt_at, last_error_code, acknowledged_at
  ) VALUES
    ('schema-four-acknowledged', 1, 'usage-session:acknowledged', '${'e'.repeat(64)}', 'upsert',
      '{"kind":"usage-session"}', 'acknowledged', '2026-10-20T10:01:00.000Z', 1, NULL, NULL,
      '2026-10-20T10:05:00.000Z'),
    ('schema-four-pending', 2, 'usage-session:pending', '${'f'.repeat(64)}', 'upsert',
      '{"kind":"usage-session"}', 'pending', '2026-10-20T10:02:00.000Z', 2,
      '2026-10-20T10:10:00.000Z', 'server-unavailable', NULL);
  PRAGMA user_version = 4;
`;

const LOCAL_MACHINE_WITHOUT_CHECK_SQL = `
  DROP TABLE usage_local_machine;
  CREATE TABLE usage_local_machine (
    singleton INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    machine_label TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// `review-attempt-store.test.ts`: the table as the first version created it, with two lost rows on one key
// and one live row.
const REVIEW_ATTEMPTS_FIRST_VERSION_SQL = `
  DROP TABLE review_attempts;
  CREATE TABLE review_attempts (
    attempt_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('read-only-review')), target_harness TEXT NOT NULL,
    source_session_id TEXT NOT NULL, desktop_session_id TEXT, checkout_path TEXT,
    checkout_origin TEXT CHECK (checkout_origin IS NULL OR checkout_origin IN ('desktop-worktree', 'desktop-cwd', 'served-session')),
    project_label TEXT, session_title TEXT, candidate_id TEXT NOT NULL,
    executor_harness TEXT NOT NULL CHECK (executor_harness IN ('claude-code', 'codex')), declaration_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('requested', 'starting', 'running', 'finished', 'failed', 'refused', 'lost')),
    requested_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, native_session_id TEXT,
    pid INTEGER, exit_code INTEGER,
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('review', 'error', 'timeout')),
    result_excerpt TEXT, num_turns INTEGER, duration_ms INTEGER, validations_json TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
    failure_reason TEXT
  );
  CREATE INDEX idx_review_attempts_target ON review_attempts(machine_id, target_harness, source_session_id, requested_at DESC);
  CREATE UNIQUE INDEX idx_review_attempts_live_identity ON review_attempts(idempotency_key) WHERE state IN ('requested', 'starting', 'running');
  INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id,
    candidate_id, executor_harness, state, requested_at, ended_at, updated_at)
  VALUES
    ('lost-1', 'machine-attempts', '${'k'.repeat(64)}', 'read-only-review', 'claude', 'cli-1', 'candidate', 'claude-code', 'lost',
      '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:15.000Z', '2026-10-22T10:00:15.000Z'),
    ('lost-2', 'machine-attempts', '${'k'.repeat(64)}', 'read-only-review', 'claude', 'cli-1', 'candidate', 'claude-code', 'lost',
      '2026-10-22T10:00:15.000Z', '2026-10-22T10:01:00.000Z', '2026-10-22T10:01:00.000Z'),
    ('live-1', 'machine-attempts', '${'k'.repeat(64)}', 'read-only-review', 'claude', 'cli-1', 'candidate', 'claude-code', 'running',
      '2026-10-22T10:02:00.000Z', NULL, '2026-10-22T10:02:00.000Z');
`;

const reviewAttemptsWithReleaseEvidence = (values: string): string => `
  DROP TABLE review_attempts;
  CREATE TABLE review_attempts (
    attempt_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('read-only-review')), target_harness TEXT NOT NULL,
    source_session_id TEXT NOT NULL, desktop_session_id TEXT, checkout_path TEXT,
    checkout_origin TEXT CHECK (checkout_origin IS NULL OR checkout_origin IN ('desktop-worktree', 'desktop-cwd', 'served-session')),
    project_label TEXT, session_title TEXT, candidate_id TEXT NOT NULL,
    executor_harness TEXT NOT NULL CHECK (executor_harness IN ('claude-code', 'codex')), declaration_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('requested', 'starting', 'running', 'finished', 'failed', 'refused', 'lost')),
    requested_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, native_session_id TEXT,
    pid INTEGER, exit_code INTEGER,
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('review', 'error', 'timeout')),
    result_excerpt TEXT, num_turns INTEGER, duration_ms INTEGER, validations_json TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
    failure_reason TEXT, launch_session_id TEXT, released_at TEXT,
    release_evidence TEXT CHECK (release_evidence IS NULL OR release_evidence IN (${values})),
    scope_json TEXT, guarantee_json TEXT
  );
  CREATE INDEX idx_review_attempts_target ON review_attempts(machine_id, target_harness, source_session_id, requested_at DESC);
  CREATE UNIQUE INDEX idx_review_attempts_reserved_identity ON review_attempts(idempotency_key)
    WHERE (state IN ('requested', 'starting', 'running') OR (state = 'lost' AND released_at IS NULL));
  INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id,
    checkout_path, checkout_origin, candidate_id, executor_harness, state, requested_at, ended_at, updated_at,
    released_at, release_evidence, scope_json, failure_reason)
  VALUES
    ('done-1', 'machine-attempts', '${'a'.repeat(64)}', 'read-only-review', 'claude', 'cli-1', '/home/fixture/work/project',
      'desktop-cwd', 'candidate', 'claude-code', 'finished', '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:15.000Z',
      '2026-10-22T10:00:15.000Z', NULL, NULL, '{"baseSha":"${'b'.repeat(40)}","headSha":"${'a'.repeat(40)}"}', NULL),
    ('lost-released', 'machine-attempts', '${'b'.repeat(64)}', 'read-only-review', 'claude', 'cli-1', NULL, NULL,
      'candidate', 'claude-code', 'lost', '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:15.000Z',
      '2026-10-22T10:00:15.000Z', '2026-10-22T10:00:15.000Z', 'process-absent', NULL, 'engine restarted');
`;

// `work-fact-store.test.ts`: the complete pull request table from the pre-R2 schema, with two rows.
const PULL_REQUESTS_BEFORE_R2_SQL = `
  DROP TABLE pull_request_observations;
  CREATE TABLE pull_request_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0), observed_at TEXT NOT NULL, outcome TEXT NOT NULL,
    outcome_message TEXT, account_label TEXT, state TEXT, draft INTEGER CHECK (draft IN (0, 1)),
    review_decision TEXT, merged_at TEXT, updated_at TEXT, title TEXT, url TEXT,
    head_ref TEXT, base_ref TEXT, checks_rollup TEXT, discovery_role TEXT, mergeable TEXT, merge_state_status TEXT
  );
  CREATE UNIQUE INDEX idx_pull_request_observations_identity
    ON pull_request_observations(machine_id, host, repository, number, observed_at DESC);
  INSERT INTO pull_request_observations
    (id, machine_id, host, repository, number, observed_at, outcome, title, state, discovery_role)
  VALUES
    (11, 'machine-a', 'github.com', 'demo/migration', 11, '2026-10-20T00:00:00.000Z', 'observed', 'Historical PR 11', 'OPEN', 'author'),
    (12, 'machine-a', 'github.com', 'demo/migration', 12, '2026-10-20T00:00:00.000Z', 'observed', 'Historical PR 12', 'OPEN', 'author');
`;

const EXECUTOR_FIRST_VERSION_SQL = `
  DROP TABLE executor_observations;
  CREATE TABLE executor_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
    observed_at TEXT NOT NULL,
    binary_path TEXT,
    version TEXT,
    auth_state TEXT NOT NULL CHECK (auth_state IN ('logged-in', 'logged-out', 'unknown')),
    auth_evidence TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'unavailable', 'timeout', 'invalid'))
  );
  INSERT INTO executor_observations (machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, outcome)
  VALUES ('machine-a', 'codex', '2026-10-21T20:00:00.000Z', '/usr/bin/codex', 'codex-cli 0.163.0', 'logged-in', 'codex login status exit 0', 'observed');
`;

const EXECUTOR_WITHOUT_FINGERPRINT_SQL = `
  DROP TABLE executor_observations;
  CREATE TABLE executor_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
    observed_at TEXT NOT NULL,
    binary_path TEXT,
    version TEXT,
    auth_state TEXT NOT NULL CHECK (auth_state IN ('logged-in', 'logged-out', 'unknown')),
    auth_evidence TEXT NOT NULL,
    auth_method TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'unavailable', 'timeout', 'invalid'))
  );
  INSERT INTO executor_observations (machine_id, harness, observed_at, binary_path, version, auth_state, auth_evidence, auth_method, outcome)
  VALUES ('machine-a', 'claude-code', '2026-10-22T07:00:00.000Z', '/usr/bin/claude', '2.1.306 (Claude Code)', 'logged-in', 'claude auth status exit 0 loggedIn=true', 'claude.ai', 'observed');
`;

const QUOTA_OVER_STREAM_BUDGET_SQL = `
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_PROVIDER_QUOTA_STREAMS + 1})
  INSERT INTO provider_quota_observations (
    provider_key, provider_label, account_scope, machine_id, machine_label, source_key, source_mode,
    source_confidence, source_event_key, state, plan, provider_generated_at, first_observed_at,
    last_observed_at, content_hash
  )
  SELECT
    'codex', 'Codex', NULL, 'machine-' || i, NULL, 'poll', 'poll', 'authoritative', NULL, 'ok', NULL, NULL,
    '2026-07-15T01:00:00.000Z', '2026-07-15T01:00:00.000Z', 'hash-' || i
  FROM n;
  DROP TABLE provider_quota_latest_heads;
  DROP TABLE provider_quota_streams;
`;

const RESET_ROW_MIGRATIONS_SQL = `
  UPDATE usage_store_metadata SET value = 0 WHERE key IN (
    'migration.merge-row-v3-vcs', 'migration.rtk-contributions-v1',
    'migration.machine-fleet-metadata-v1', 'migration.machine-fleet-order-v1'
  );
`;

// `index.test.ts`: a pre-VCS row fingerprint, a row with embedded RTK fields and no enrichment, plus a row
// whose JSON does not parse, with every row-level migration marker reset.
const shapeLegacyRows = async (dbPath: string): Promise<void> => {
  const preVcs = codexRow('pre-vcs-row');
  const embeddedRtk = {
    ...codexRow('legacy-rtk'),
    rtkCommandCount: 2,
    rtkInputTokens: 30,
    rtkOutputTokens: 10,
    rtkSavedTokens: 20,
  };
  await Effect.runPromise(importLocalRows({ dbPath, machine: MACHINE, rows: [preVcs, embeddedRtk] }));
  await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath }));
  const current = toSerializedMergeRow(preVcs, MACHINE);
  const legacySourceFingerprint = usageContentHash({
    activeDate: current.activeDate,
    date: current.date,
    endDate: current.endDate,
    harness: current.harness,
    model: current.model,
    models: current.models ?? [],
    name: current.name,
    project: current.project,
    provider: current.provider,
    sourcePath: current.source.sourcePath ?? current.source.artifactPath ?? null,
    tokenTotal: current.tokenTotal,
  });
  const { contentHash: _contentHash, sourceFingerprint: _sourceFingerprint, ...legacyContent } = current;
  const legacy = { ...legacyContent, sourceFingerprint: legacySourceFingerprint };
  const legacyContentHash = usageContentHash(legacy);
  const serializedRtk = toSerializedMergeRow(embeddedRtk, MACHINE);
  withRawDatabase(dbPath, (db) => {
    db.query('UPDATE usage_rows SET source_fingerprint = ?, content_hash = ?, row_json = ? WHERE row_key = ?').run(
      legacySourceFingerprint,
      legacyContentHash,
      JSON.stringify({ ...legacy, contentHash: legacyContentHash }),
      current.rowKey,
    );
    db.query('UPDATE usage_rows SET content_hash = ?, row_json = ? WHERE row_key = ?').run(
      serializedRtk.contentHash,
      JSON.stringify(serializedRtk),
      serializedRtk.rowKey,
    );
    db.query('DELETE FROM usage_row_enrichments WHERE row_key = ?').run(serializedRtk.rowKey);
    db.exec(`
      INSERT INTO usage_rows (
        origin_machine_id, harness_key, source_session_id, source_fingerprint, source_authority, row_key,
        content_hash, row_json, machine_label, fleet_metadata_valid, status, active_date, project, model,
        token_total, first_seen_at, last_seen_at, updated_at
      )
      SELECT
        origin_machine_id, harness_key, 'unparseable-row', source_fingerprint, source_authority, 'unparseable-row-key',
        content_hash, '{broken', machine_label, fleet_metadata_valid, status, active_date, project, model,
        token_total, first_seen_at, last_seen_at, updated_at
      FROM usage_rows WHERE row_key = '${current.rowKey}';
    `);
    db.exec(RESET_ROW_MIGRATIONS_SQL);
  });
};

// A usage_rows table from before source authority and the fleet metadata columns (with their index and
// triggers), whose fleet migrations have not run yet.
const USAGE_ROWS_BEFORE_FLEET_COLUMNS_SQL = `
  DROP TRIGGER usage_rows_invalidate_fleet_metadata_after_insert;
  DROP TRIGGER usage_rows_invalidate_fleet_metadata_after_update;
  DROP INDEX idx_usage_rows_fleet;
  ALTER TABLE usage_rows DROP COLUMN fleet_metadata_valid;
  ALTER TABLE usage_rows DROP COLUMN machine_label;
  ALTER TABLE usage_rows DROP COLUMN source_authority;
  UPDATE usage_store_metadata SET value = 0 WHERE key IN (
    'migration.machine-fleet-metadata-v1', 'migration.machine-fleet-order-v1'
  );
`;

interface StoreShape {
  readonly build?: (dbPath: string) => void | Promise<void>;
  readonly name: string;
  // A shape on top of the populated store; otherwise the build starts from an absent file.
  readonly populated: boolean;
}

const shapes: readonly StoreShape[] = [
  { name: 'fresh absent store', populated: false },
  {
    build: execOn(`
      CREATE TABLE legacy_marker (value TEXT NOT NULL);
      INSERT INTO legacy_marker (value) VALUES ('preserved');
      CREATE VIEW served_report_rows AS SELECT 1 AS incompatible;
      PRAGMA user_version = 0;
    `),
    name: 'schema 0 with a view named served_report_rows (fails)',
    populated: false,
  },
  {
    build: execOn(`
      CREATE TABLE legacy_marker (value TEXT NOT NULL);
      INSERT INTO legacy_marker (value) VALUES ('preserved');
      PRAGMA user_version = 0;
    `),
    name: 'schema 0 with an unrelated table',
    populated: false,
  },
  { name: 'populated schema 5 reopened', populated: true },
  { build: execOn(SCHEMA_FOUR_OUTBOX_SQL), name: 'populated schema 4 with the replication outbox', populated: true },
  { build: execOn('PRAGMA user_version = 3'), name: 'populated schema 3', populated: true },
  {
    build: execOn(`
      DROP INDEX idx_served_report_rows_local_time_cell;
      ALTER TABLE served_report_rows DROP COLUMN local_time_weekday;
      ALTER TABLE served_report_rows DROP COLUMN local_time_hour;
      ALTER TABLE served_report_rows DROP COLUMN harness_provider_key;
      ALTER TABLE served_report_rows DROP COLUMN lines_measured;
      PRAGMA user_version = 2;
    `),
    name: 'schema 2 with an older served projection (fails)',
    populated: true,
  },
  {
    build: execOn('DROP TABLE usage_local_machine; PRAGMA user_version = 1;'),
    name: 'schema 1 without the local machine projection',
    populated: true,
  },
  {
    build: execOn(`${LOCAL_MACHINE_WITHOUT_CHECK_SQL} PRAGMA user_version = 1;`),
    name: 'schema 1 with a same-name local machine table without its CHECK (fails)',
    populated: true,
  },
  {
    build: execOn(`${SCHEMA_FOUR_OUTBOX_SQL} ${LOCAL_MACHINE_WITHOUT_CHECK_SQL}`),
    name: 'schema 4 with a same-name local machine table without its CHECK (fails)',
    populated: true,
  },
  {
    build: execOn('PRAGMA user_version = 6'),
    name: 'schema 6 newer than supported (fails)',
    populated: true,
  },
  {
    build: execOn('DROP TABLE provider_quota_latest_heads; DROP TABLE provider_quota_streams;'),
    name: 'quota read projections missing',
    populated: true,
  },
  {
    build: execOn(QUOTA_OVER_STREAM_BUDGET_SQL),
    name: 'quota history over the stream read budget (fails)',
    populated: true,
  },
  {
    build: execOn('DROP TABLE skill_observations; DROP TABLE skill_observation_collection_state;'),
    name: 'skill observation family missing',
    populated: true,
  },
  {
    build: execOn('DROP TABLE skill_observation_collection_state;'),
    name: 'skill observation collection state missing',
    populated: true,
  },
  { build: execOn('DROP TABLE executor_observations;'), name: 'executor observations missing', populated: true },
  {
    build: execOn(EXECUTOR_FIRST_VERSION_SQL),
    name: 'executor observations from the first version',
    populated: true,
  },
  {
    build: execOn(EXECUTOR_WITHOUT_FINGERPRINT_SQL),
    name: 'executor observations without the account fingerprint',
    populated: true,
  },
  {
    build: execOn('DROP TABLE executor_account_changes;'),
    name: 'executor account-change barrier missing',
    populated: true,
  },
  {
    build: execOn(
      'DROP TABLE delegation_evaluations; DROP TABLE delegation_jobs; DROP TABLE delegation_qualifications;',
    ),
    name: 'delegation tables missing',
    populated: true,
  },
  {
    build: execOn(
      'DROP TABLE claude_desktop_sessions; DROP TABLE claude_desktop_collection_state; DROP TABLE claude_desktop_turn_declarations;',
    ),
    name: 'Claude Desktop session family missing',
    populated: true,
  },
  {
    build: execOn(
      'DROP TABLE claude_desktop_turn_declarations; ALTER TABLE claude_desktop_sessions DROP COLUMN latest_user_frame_at;',
    ),
    name: 'Claude Desktop family before the declaration history and the message time',
    populated: true,
  },
  {
    build: execOn('DROP TABLE codex_work_observations; DROP TABLE codex_work_collection_coverage;'),
    name: 'Codex work tables missing',
    populated: true,
  },
  {
    build: execOn(
      'DROP TABLE work_thread_combinations; DROP TABLE work_jira_intake; DROP TABLE work_thread_commands; DROP TABLE work_thread_events; DROP TABLE work_thread_links; DROP TABLE work_threads',
    ),
    name: 'Work thread tables missing',
    populated: true,
  },
  {
    build: execOn(
      'ALTER TABLE checkout_status_observations DROP COLUMN counts_changed_at; ALTER TABLE work_fact_run_state DROP COLUMN outcome_code;',
    ),
    name: 'work fact evidence columns missing',
    populated: true,
  },
  { build: execOn(PULL_REQUESTS_BEFORE_R2_SQL), name: 'pull request table from before R2', populated: true },
  {
    build: execOn(`
      ALTER TABLE pull_request_observations DROP COLUMN discovery_role;
      ALTER TABLE pull_request_observations DROP COLUMN mergeable;
      ALTER TABLE pull_request_observations DROP COLUMN merge_state_status;
    `),
    name: 'pull request discovery columns missing',
    populated: true,
  },
  {
    build: execOn(`
      ALTER TABLE jira_issue_observations DROP COLUMN url;
      ALTER TABLE jira_issue_observations DROP COLUMN handed_off;
      DROP TABLE jira_sync_state;
    `),
    name: 'Jira columns and sync state missing',
    populated: true,
  },
  {
    build: execOn(REVIEW_ATTEMPTS_FIRST_VERSION_SQL),
    name: 'review attempts from the first version',
    populated: true,
  },
  {
    build: execOn(
      reviewAttemptsWithReleaseEvidence("'process-absent', 'outcome-recorded-late', 'recorded-before-reservations'"),
    ),
    name: 'review attempts from the reservation version',
    populated: true,
  },
  {
    build: execOn(
      reviewAttemptsWithReleaseEvidence(
        "'process-absent', 'outcome-recorded-late', 'recorded-before-reservations', 'operator-declared-ended'",
      ),
    ),
    name: 'review attempts from the operator-release version',
    populated: true,
  },
  {
    build: execOn(
      'ALTER TABLE review_attempts DROP COLUMN native_turn_id; ALTER TABLE review_attempts DROP COLUMN stop_requested_at; ALTER TABLE review_attempts DROP COLUMN stop_confirmed_at;',
    ),
    name: 'review attempts without the stop evidence columns',
    populated: true,
  },
  { build: shapeLegacyRows, name: 'usage rows awaiting every row-level migration', populated: true },
  {
    build: execOn(USAGE_ROWS_BEFORE_FLEET_COLUMNS_SQL),
    name: 'usage rows before source authority and fleet metadata',
    populated: true,
  },
];

// ---------------------------------------------------------------------------------------------------------

const results = new Map<string, ShapeResult>();

const buildShape = async (shape: StoreShape, populatedTemplate: string): Promise<string> => {
  const dbPath = await temporaryPath('usage-store-characterization-');
  if (shape.populated) {
    await copyFile(populatedTemplate, dbPath);
  }
  if (shape.build !== undefined) {
    if (!shape.populated) {
      new Database(dbPath).close(true);
    }
    await shape.build(dbPath);
  }
  return dbPath;
};

beforeAll(async () => {
  setSystemTime(FROZEN_NOW);
  const populatedTemplate = await temporaryPath('usage-store-characterization-template-');
  await populateThroughTheWriter(populatedTemplate);
  for (const shape of shapes) {
    results.set(shape.name, captureShape(await buildShape(shape, populatedTemplate)));
  }
});

afterAll(async () => {
  setSystemTime();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const resultOf = (name: string): ShapeResult => {
  const result = results.get(name);
  if (result === undefined) {
    throw new Error(`No characterization result for ${name}`);
  }
  return result;
};

const FRESH_SHAPE = 'fresh absent store';

// A shape's schema as the rows it has beyond the fresh store's (`+`) and the fresh rows it lacks (`-`);
// `(type, name)` is unique in `sqlite_schema`, so this and the fresh schema determine it exactly.
const schemaAgainstFreshStore = (schema: readonly string[]): string[] => {
  const fresh = resultOf(FRESH_SHAPE).capture.schema;
  const freshRows = new Set(fresh);
  const ownRows = new Set(schema);
  return [
    ...schema.filter((row) => !freshRows.has(row)).map((row) => `+ ${row}`),
    ...fresh.filter((row) => !ownRows.has(row)).map((row) => `- ${row}`),
  ];
};

describe('migrate() characterization', () => {
  test('the fresh store schema, every sqlite_schema row', () => {
    expect(resultOf(FRESH_SHAPE).capture.schema).toMatchSnapshot();
  });

  for (const shape of shapes) {
    test(shape.name, () => {
      const result = resultOf(shape.name);
      const { schema, ...capture } = result.capture;
      expect({ ...capture, schemaAgainstFreshStore: schemaAgainstFreshStore(schema) }).toMatchSnapshot();
      if (result.capture.outcome.error === undefined) {
        expect(result.capture.afterSecondRun?.outcome).toEqual({ schemaChanged: false });
        expect(result.schemaAfterSecondRun).toEqual(result.schemaAfterFirstRun);
      }
    });
  }

  test('every SQL text referenced above, by key', () => {
    const texts = new Map<string, string>();
    for (const shape of shapes) {
      for (const [key, sql] of resultOf(shape.name).texts) {
        texts.set(key, sql);
      }
    }
    expect(Object.fromEntries([...texts].sort(([left], [right]) => left.localeCompare(right)))).toMatchSnapshot();
  });
});
