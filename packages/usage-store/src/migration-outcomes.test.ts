import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toSerializedMergeRow, usageContentHash } from '@ai-usage/report-core/merge-bundle';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { completeSkillObservationCollection } from '@ai-usage/report-core/skill-observation';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { initializeUsageStore, migrateWriterDatabase, quiesceUsageStoreForShutdown } from './connections';
import type { UsageStoreError } from './errors';
import { USAGE_STORE_SCHEMA_VERSION, UsageStoreSchemaTooNewError } from './migration';
import { MAX_PROVIDER_QUOTA_STREAMS } from './provider-quota-store';
import { enrichmentContentHash, RTK_SAVINGS_SCHEMA_VERSION, RTK_SAVINGS_SOURCE_ID } from './rtk-savings';
import { SERVED_REPORT_PROJECTION_SCHEMA_VERSION } from './served-revision';
import { createTrackedSqliteDatabase, type RawSqliteDatabase } from './sqlite-database';
import { queryWorkFactRunStates, recordWorkFactRun } from './work-fact-store';
import {
  importClaudeDesktopSessions,
  importExecutorObservations,
  importLocalRows,
  importProviderQuotaBatch,
  importSkillObservations,
  updateUsageMachineLabel,
} from './writer';

// What `migrate()` must achieve for every store shape the usage-store tests know how to build: the
// schema a fresh store has (or a named, explained difference), schema version 5, idempotence, the
// row-level result of every data-rewriting step, and for a failing shape a typed error that leaves the
// store untouched. Every migration goes through the real writer open (`initializeUsageStore`).

const FROZEN_NOW = '2026-11-01T12:00:00.000Z';
const MACHINE = { id: 'characterization-machine', label: 'Characterization machine' };

const temporaryRoots: string[] = [];
const templateRoots: string[] = [];

beforeEach(() => {
  setSystemTime(new Date(FROZEN_NOW));
});

afterEach(async () => {
  setSystemTime();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

afterAll(async () => {
  await Promise.all(templateRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// ---------------------------------------------------------------------------------------------------------
// A normalised description of a store's schema. `sqlite_schema.sql` text cannot be compared directly: an
// `ALTER TABLE ... ADD COLUMN` appends the column to the stored text, so a migrated table differs in text
// and column order from a fresh `CREATE`. What is compared is what SQLite enforces: per column its
// declared type, NOT NULL, DEFAULT, primary-key position and hidden flag; per table every CHECK clause,
// every COLLATE with the column it belongs to, every foreign key, STRICT and WITHOUT ROWID; per index its
// columns, uniqueness, partial flag and text; triggers by name and text; views by name.
// Blind spots (none of these constructs exists in the production DDL today): a column's `ON CONFLICT`
// clause, `DEFERRABLE` on a foreign key, `AUTOINCREMENT`, a generated column's expression (only its hidden
// flag is seen) and a view's body. A change to one of them reaches only the fresh schema digest.

interface ColumnDescription {
  readonly default: string | null;
  readonly hidden: number;
  readonly notnull: number;
  readonly pk: number;
  readonly type: string;
}

interface TableDescription {
  readonly checks: readonly string[];
  readonly collations: readonly string[];
  readonly columns: Readonly<Record<string, ColumnDescription>>;
  readonly foreignKeys: readonly string[];
  readonly strict: boolean;
  readonly withoutRowid: boolean;
}

interface IndexDescription {
  readonly columns: readonly string[];
  readonly partial: boolean;
  // Null for the automatic index of a PRIMARY KEY or UNIQUE constraint.
  readonly sql: string | null;
  readonly table: string;
  readonly unique: boolean;
}

interface SchemaDescription {
  readonly indexes: Readonly<Record<string, IndexDescription>>;
  readonly tables: Readonly<Record<string, TableDescription>>;
  readonly triggers: Readonly<Record<string, string>>;
  readonly views: readonly string[];
}

const normalizedSql = (sql: string): string =>
  sql
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .trim();

// Every `CHECK (...)` of a table's text, with balanced parentheses, normalised and sorted.
const checkClauses = (sql: string): string[] => {
  const clauses: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  for (let match = pattern.exec(sql); match !== null; match = pattern.exec(sql)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < sql.length && depth > 0) {
      if (sql[index] === '(') {
        depth++;
      } else if (sql[index] === ')') {
        depth--;
      }
      index++;
    }
    clauses.push(normalizedSql(sql.slice(match.index, index)));
  }
  return clauses.sort();
};

// A table's definitions (columns and table constraints, an added column appended last): its text inside
// the outer parentheses, `--` comments removed, split at the commas outside parentheses and quotes.
const tableDefinitions = (sql: string): string[] => {
  const text = sql.replace(/--[^\n]*/g, '');
  const definitions: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = text.indexOf('(') + 1;
  for (let index = start; index < text.length && depth >= 0; index++) {
    const char = text[index] ?? '';
    if (quote !== null) {
      quote = char === quote ? null : quote;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === ')') {
      depth += char === '(' ? 1 : -1;
    }
    if (quote === null && ((char === ',' && depth === 0) || depth < 0)) {
      definitions.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return definitions;
};

const DEFINITION_OWNER = /^\s*["`[]?(\w+)/;
const COLLATE_CLAUSE = /\bCOLLATE\s+("?\w+"?)/gi;

// Every COLLATE as `<column> COLLATE <name>` (a table constraint's COLLATE under its keyword), sorted.
const collationClauses = (sql: string): string[] =>
  tableDefinitions(sql)
    .flatMap((definition) => {
      const owner = DEFINITION_OWNER.exec(definition)?.[1] ?? '';
      return [...definition.matchAll(COLLATE_CLAUSE)].map((match) => `${owner} COLLATE ${match[1]?.toUpperCase()}`);
    })
    .sort();

interface SchemaRow {
  readonly name: string;
  readonly sql: string | null;
  readonly type: string;
}

const describeTable = (db: Database, row: SchemaRow): TableDescription => {
  const columns = db.query(`PRAGMA table_xinfo("${row.name}")`).all() as Array<{
    dflt_value: string | null;
    hidden: number;
    name: string;
    notnull: number;
    pk: number;
    type: string;
  }>;
  const foreignKeys = db.query(`PRAGMA foreign_key_list("${row.name}")`).all() as Array<{
    from: string;
    on_delete: string;
    on_update: string;
    table: string;
    to: string | null;
  }>;
  const list = db.query(`PRAGMA table_list("${row.name}")`).get() as { strict: number; wr: number };
  return {
    checks: checkClauses(row.sql ?? ''),
    collations: collationClauses(row.sql ?? ''),
    columns: Object.fromEntries(
      columns
        .map(
          (column) =>
            [
              column.name,
              {
                default: column.dflt_value,
                hidden: column.hidden,
                notnull: column.notnull,
                pk: column.pk,
                type: column.type,
              },
            ] as const,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    foreignKeys: foreignKeys
      .map(
        (key) => `${key.from} -> ${key.table}(${key.to ?? ''}) on delete ${key.on_delete} on update ${key.on_update}`,
      )
      .sort(),
    strict: list.strict === 1,
    withoutRowid: list.wr === 1,
  };
};

const describeIndexes = (db: Database, table: string): [string, IndexDescription][] =>
  (
    db.query(`PRAGMA index_list("${table}")`).all() as Array<{
      name: string;
      origin: string;
      partial: number;
      unique: number;
    }>
  ).map((index) => {
    const columns = (
      db.query(`PRAGMA index_xinfo("${index.name}")`).all() as Array<{ desc: number; key: number; name: string | null }>
    )
      .filter((column) => column.key === 1)
      .map((column) => `${column.name ?? '<expression>'}${column.desc === 1 ? ' DESC' : ''}`);
    const record = db.query("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(index.name) as {
      sql: string | null;
    } | null;
    // Automatic indexes are numbered in declaration order, which an ALTER-built table does not share.
    const key = index.origin === 'c' ? index.name : `${table} ${index.origin}(${columns.join(', ')})`;
    return [
      key,
      {
        columns,
        partial: index.partial === 1,
        sql: typeof record?.sql === 'string' ? normalizedSql(record.sql) : null,
        table,
        unique: index.unique === 1,
      },
    ];
  });

const describeSchema = (db: Database): SchemaDescription => {
  const rows = db
    .query("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as SchemaRow[];
  const tables = rows.filter((row) => row.type === 'table');
  return {
    indexes: Object.fromEntries(
      tables.flatMap((row) => describeIndexes(db, row.name)).sort(([left], [right]) => left.localeCompare(right)),
    ),
    tables: Object.fromEntries(tables.map((row) => [row.name, describeTable(db, row)])),
    triggers: Object.fromEntries(
      rows.filter((row) => row.type === 'trigger').map((row) => [row.name, normalizedSql(row.sql ?? '')]),
    ),
    views: rows.filter((row) => row.type === 'view').map((row) => row.name),
  };
};

const multisetDifferences = (label: string, actual: readonly string[], expected: readonly string[]): string[] => {
  const remaining = [...expected];
  const added: string[] = [];
  for (const item of actual) {
    const index = remaining.indexOf(item);
    if (index === -1) {
      added.push(`+ ${label}: ${item}`);
    } else {
      remaining.splice(index, 1);
    }
  }
  return [...added, ...remaining.map((item) => `- ${label}: ${item}`)];
};

const tableDifferences = (name: string, actual: TableDescription, expected: TableDescription): string[] => {
  const lines: string[] = [];
  for (const column of new Set([...Object.keys(actual.columns), ...Object.keys(expected.columns)])) {
    const left = actual.columns[column];
    const right = expected.columns[column];
    if (right === undefined) {
      lines.push(`+ column ${name}.${column}`);
    } else if (left === undefined) {
      lines.push(`- column ${name}.${column}`);
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      lines.push(`~ column ${name}.${column}: ${JSON.stringify(left)}, fresh ${JSON.stringify(right)}`);
    }
  }
  lines.push(
    ...multisetDifferences(`check ${name}`, actual.checks, expected.checks),
    ...multisetDifferences(`collation ${name}`, actual.collations, expected.collations),
    ...multisetDifferences(`foreign key ${name}`, actual.foreignKeys, expected.foreignKeys),
  );
  if (actual.strict !== expected.strict) {
    lines.push(`~ table ${name} strict: ${actual.strict}`);
  }
  if (actual.withoutRowid !== expected.withoutRowid) {
    lines.push(`~ table ${name} without rowid: ${actual.withoutRowid}`);
  }
  return lines;
};

const recordDifferences = <T>(
  kind: string,
  actual: Readonly<Record<string, T>>,
  expected: Readonly<Record<string, T>>,
): string[] => [
  ...Object.keys(actual).flatMap((name) => {
    if (!(name in expected)) {
      return [`+ ${kind} ${name}`];
    }
    return JSON.stringify(actual[name]) === JSON.stringify(expected[name])
      ? []
      : [`~ ${kind} ${name}: ${JSON.stringify(actual[name])}, fresh ${JSON.stringify(expected[name])}`];
  }),
  ...Object.keys(expected)
    .filter((name) => !(name in actual))
    .map((name) => `- ${kind} ${name}`),
];

/** How a store's schema differs from a fresh store's, one readable line per difference; `[]` when equivalent. */
const schemaDifferences = (actual: SchemaDescription, expected: SchemaDescription): string[] => [
  ...Object.keys(actual.tables).flatMap((name) => {
    const left = actual.tables[name];
    const right = expected.tables[name];
    return left === undefined || right === undefined ? [] : tableDifferences(name, left, right);
  }),
  ...Object.keys(actual.tables)
    .filter((name) => !(name in expected.tables))
    .map((name) => `+ table ${name}`),
  ...Object.keys(expected.tables)
    .filter((name) => !(name in actual.tables))
    .map((name) => `- table ${name}`),
  ...recordDifferences('index', actual.indexes, expected.indexes),
  ...recordDifferences('trigger', actual.triggers, expected.triggers),
  ...multisetDifferences('view', actual.views, expected.views),
];

// ---------------------------------------------------------------------------------------------------------
// Store access.

const withDatabase = <A>(dbPath: string, use: (db: Database) => A): A => {
  const db = new Database(dbPath, { create: false, readwrite: true });
  try {
    return use(db);
  } finally {
    db.close(true);
  }
};

const rowsOf = (dbPath: string, sql: string): unknown[] => withDatabase(dbPath, (db) => db.query(sql).all());

const userVersionOf = (dbPath: string): number =>
  withDatabase(dbPath, (db) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version);

const metadataOf = (dbPath: string): Record<string, number> =>
  Object.fromEntries(
    (
      rowsOf(dbPath, 'SELECT key, value FROM usage_store_metadata ORDER BY key') as Array<{
        key: string;
        value: number;
      }>
    ).map(({ key, value }) => [key, value]),
  );

// Every row of every table as sorted JSON lines.
const tableRowsOf = (dbPath: string): Record<string, string[]> =>
  withDatabase(dbPath, (db) =>
    Object.fromEntries(
      (
        db
          .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map(({ name }) => [
        name,
        db
          .query(`SELECT * FROM "${name}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    ),
  );

const withoutTables = (rows: Record<string, string[]>, tables: readonly string[]): Record<string, string[]> =>
  Object.fromEntries(Object.entries(rows).filter(([table]) => !tables.includes(table)));

const schemaOf = (dbPath: string): SchemaDescription => withDatabase(dbPath, describeSchema);

const temporaryPath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-migration-outcomes-'));
  temporaryRoots.push(root);
  return path.join(root, 'usage-store.sqlite');
};

let freshSchemaPromise: Promise<SchemaDescription> | undefined;

// The schema of a store the writer created from nothing, built once per file on first use.
const freshSchema = (): Promise<SchemaDescription> => {
  freshSchemaPromise ??= (async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-migration-fresh-'));
    templateRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    return schemaOf(dbPath);
  })();
  return freshSchemaPromise;
};

// `migrate()`'s own result is not visible through the writer open, so it is read on the production
// migration boundary (`migrateWriterDatabase`) over a plain connection; no pragma is needed for the result.
const migrateOnBoundary = (dbPath: string): boolean => {
  const db = createTrackedSqliteDatabase(new Database(dbPath) as unknown as RawSqliteDatabase);
  try {
    return migrateWriterDatabase(db, dbPath);
  } finally {
    db.close(true);
  }
};

interface MigratedShape {
  // What `migrate()` returned on the shape, read on an identical copy.
  readonly changed: boolean;
  // What the writer open (`initializeUsageStore`) returned.
  readonly opened: number;
  // A second migration of the migrated store.
  readonly rerun: { readonly changed: boolean; readonly rowsUnchanged: boolean; readonly schemaUnchanged: boolean };
  readonly schema: SchemaDescription;
  readonly userVersion: number;
}

/** Migrates a shape through the real writer open, then migrates it again. */
const migrateShape = async (dbPath: string): Promise<MigratedShape> => {
  const probePath = `${dbPath}.probe`;
  if (existsSync(dbPath)) {
    await copyFile(dbPath, probePath);
  }
  const changed = migrateOnBoundary(probePath);
  const opened = await Effect.runPromise(initializeUsageStore({ dbPath }));
  const schema = schemaOf(dbPath);
  const rows = JSON.stringify(tableRowsOf(dbPath));
  const rerunChanged = migrateOnBoundary(dbPath);
  return {
    changed,
    opened,
    rerun: {
      changed: rerunChanged,
      rowsUnchanged: JSON.stringify(tableRowsOf(dbPath)) === rows,
      schemaUnchanged: JSON.stringify(schemaOf(dbPath)) === JSON.stringify(schema),
    },
    schema,
    userVersion: userVersionOf(dbPath),
  };
};

/** What every successful migration must report: version 5, and a second run that changes nothing. */
const idempotent = (changed: boolean): Omit<MigratedShape, 'schema'> => ({
  changed,
  opened: USAGE_STORE_SCHEMA_VERSION,
  rerun: { changed: false, rowsUnchanged: true, schemaUnchanged: true },
  userVersion: USAGE_STORE_SCHEMA_VERSION,
});

/** A shape's migration outcome beside the differences of its schema from a fresh store's. */
const migrationAgainstFresh = async (
  dbPath: string,
): Promise<{ differences: string[]; outcome: Omit<MigratedShape, 'schema'> }> => {
  const { schema, ...outcome } = await migrateShape(dbPath);
  return { differences: schemaDifferences(schema, await freshSchema()), outcome };
};

const convergedToFresh = (changed: boolean, differences: string[] = []) => ({
  differences,
  outcome: idempotent(changed),
});

interface StoreState {
  readonly rows: Record<string, string[]>;
  readonly schema: SchemaDescription;
  readonly userVersion: number;
}

const storeStateOf = (dbPath: string): StoreState => ({
  rows: tableRowsOf(dbPath),
  schema: schemaOf(dbPath),
  userVersion: userVersionOf(dbPath),
});

/** Opens a shape that must fail through the writer; returns the error and the store before and after. */
const failWriterOpen = async (
  dbPath: string,
): Promise<{ failure: UsageStoreError; storeAfter: StoreState; storeBefore: StoreState }> => {
  const storeBefore = storeStateOf(dbPath);
  const result = await Effect.runPromise(Effect.result(initializeUsageStore({ dbPath })));
  if (result._tag !== 'Failure') {
    throw new Error('Expected the writer open to fail.');
  }
  return { failure: result.failure, storeAfter: storeStateOf(dbPath), storeBefore };
};

// ---------------------------------------------------------------------------------------------------------
// Store shapes. The builders come from `migration.test.ts`, `index.test.ts`, `review-attempt-store.test.ts`,
// `work-fact-store.test.ts` and `codex-work-store.integration.test.ts`.

const execOn =
  (sql: string) =>
  (dbPath: string): void =>
    withDatabase(dbPath, (db) => {
      db.exec(sql);
    });

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

const RTK_CONTRIBUTION = { rtkCommandCount: 2, rtkInputTokens: 30, rtkOutputTokens: 10, rtkSavedTokens: 20 };

const withEmbeddedRtk = (row: UsageRowWithOptionalSource): UsageRowWithOptionalSource => ({
  ...row,
  ...RTK_CONTRIBUTION,
});

// The row as a pre-VCS writer stored it: the legacy source fingerprint, and the content hash over it.
const preVcsStoredRow = (row: UsageRowWithOptionalSource) => {
  const current = toSerializedMergeRow(row, MACHINE);
  const sourceFingerprint = usageContentHash({
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
  const legacy = { ...legacyContent, sourceFingerprint };
  const contentHash = usageContentHash(legacy);
  return {
    contentHash,
    rowJson: JSON.stringify({ ...legacy, contentHash }),
    rowKey: current.rowKey,
    sourceFingerprint,
  };
};

// `index.test.ts`: a pre-VCS row fingerprint, a row with embedded RTK fields and no enrichment, a pre-VCS row
// that also embeds RTK fields (the RTK step can only read it once the VCS step has rewritten it), plus a row
// whose JSON does not parse, with every row-level migration marker reset.
const shapeLegacyRows = async (dbPath: string): Promise<void> => {
  const preVcs = codexRow('pre-vcs-row');
  const embeddedRtk = withEmbeddedRtk(codexRow('legacy-rtk'));
  const preVcsRtk = withEmbeddedRtk(codexRow('pre-vcs-rtk'));
  await Effect.runPromise(importLocalRows({ dbPath, machine: MACHINE, rows: [preVcs, embeddedRtk, preVcsRtk] }));
  await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath }));
  const current = toSerializedMergeRow(preVcs, MACHINE);
  const serializedRtk = toSerializedMergeRow(embeddedRtk, MACHINE);
  withDatabase(dbPath, (db) => {
    for (const legacy of [preVcsStoredRow(preVcs), preVcsStoredRow(preVcsRtk)]) {
      db.query('UPDATE usage_rows SET source_fingerprint = ?, content_hash = ?, row_json = ? WHERE row_key = ?').run(
        legacy.sourceFingerprint,
        legacy.contentHash,
        legacy.rowJson,
        legacy.rowKey,
      );
    }
    db.query('DELETE FROM usage_row_enrichments WHERE row_key = ?').run(
      toSerializedMergeRow(preVcsRtk, MACHINE).rowKey,
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

const CLAUDE_ROW_KEY = toSerializedMergeRow(claudeRow(), MACHINE).rowKey;

// The tables and named indexes of schema 5. Every other test compares a migrated store with a fresh one,
// so this list is what pins the fresh store itself: a migration that adds or loses a table or an index
// must change it here, in a reviewable line.
const FRESH_TABLES: readonly string[] = [
  'checkout_status_observations',
  'claude_desktop_collection_state',
  'claude_desktop_sessions',
  'claude_desktop_turn_declarations',
  'codex_work_collection_coverage',
  'codex_work_observations',
  'collected_dataset_items',
  'delegation_evaluations',
  'delegation_jobs',
  'delegation_qualifications',
  'executor_account_changes',
  'executor_observations',
  'jira_issue_observations',
  'jira_sync_state',
  'provider_quota_latest_heads',
  'provider_quota_observations',
  'provider_quota_source_events',
  'provider_quota_source_state',
  'provider_quota_streams',
  'provider_quota_windows',
  'pull_request_observations',
  'review_attempts',
  'served_report_current',
  'served_report_local_context',
  'served_report_revisions',
  'served_report_rows',
  'served_report_support',
  'served_session_model_filter_keys',
  'served_session_model_segments',
  'skill_observation_collection_state',
  'skill_observations',
  'usage_local_machine',
  'usage_machine_fleet_order',
  'usage_row_enrichments',
  'usage_rows',
  'usage_store_metadata',
  'work_branch_reconciliation',
  'work_fact_run_state',
  'work_jira_intake',
  'work_session_branch_builds',
  'work_session_branches',
  'work_thread_combinations',
  'work_thread_commands',
  'work_thread_events',
  'work_thread_links',
  'work_threads',
];
const FRESH_INDEXES: readonly string[] = [
  'idx_checkout_status_observations_identity',
  'idx_claude_desktop_sessions_activity',
  'idx_claude_desktop_sessions_cli',
  'idx_claude_desktop_sessions_identity',
  'idx_collected_dataset_items_query',
  'idx_delegation_evaluations_job',
  'idx_delegation_jobs_machine_state',
  'idx_delegation_jobs_pool',
  'idx_delegation_jobs_reserved_target',
  'idx_delegation_jobs_retry_of',
  'idx_delegation_jobs_target',
  'idx_delegation_qualifications_machine',
  'idx_executor_observations_latest',
  'idx_jira_issue_observations_identity',
  'idx_provider_quota_anchor_exact',
  'idx_provider_quota_anchor_normalized',
  'idx_provider_quota_heads_machine',
  'idx_provider_quota_heads_order',
  'idx_provider_quota_heads_provider',
  'idx_provider_quota_heads_provider_machine',
  'idx_provider_quota_latest',
  'idx_provider_quota_observed_range',
  'idx_provider_quota_range_account',
  'idx_provider_quota_range_all',
  'idx_provider_quota_range_machine',
  'idx_provider_quota_range_machine_account',
  'idx_provider_quota_range_provider',
  'idx_provider_quota_range_provider_account',
  'idx_provider_quota_range_provider_machine',
  'idx_provider_quota_range_provider_machine_account',
  'idx_provider_quota_source_event',
  'idx_provider_quota_source_events_observation',
  'idx_pull_request_observations_identity',
  'idx_review_attempts_reserved_identity',
  'idx_review_attempts_target',
  'idx_served_report_revisions_retention',
  'idx_served_report_rows_active_time',
  'idx_served_report_rows_campaign',
  'idx_served_report_rows_facets',
  'idx_served_report_rows_local_time_cell',
  'idx_served_report_rows_provider_scope',
  'idx_served_session_model_segments_model',
  'idx_skill_observations_identity',
  'idx_skill_observations_machine',
  'idx_skill_observations_range',
  'idx_skill_observations_skill',
  'idx_skill_observations_tier',
  'idx_usage_row_enrichments_source',
  'idx_usage_rows_active_date',
  'idx_usage_rows_fleet',
  'idx_usage_rows_model',
  'idx_usage_rows_origin_status',
  'idx_usage_rows_project',
  'idx_work_session_branches_key',
  'idx_work_thread_active_link',
  'idx_work_thread_combinations_active',
  'idx_work_thread_events',
  'idx_work_thread_link_history',
  'idx_work_threads_activity',
  'idx_work_threads_scope',
];

// The SHA-256 of the fresh store's DDL: the `sqlite_schema` text of every table, index, trigger and view,
// `--` comments removed and whitespace normalised, one `type name: sql` line each, ordered by name. See the
// tripwire test for what a change means.
const FRESH_SCHEMA_DIGEST = 'c07c4cf582ddf3cbd219c59c4e2733ca4b9b28386ef8b71fe5e93828c699f261';

const freshSchemaDigest = (dbPath: string): string => {
  const lines = (
    rowsOf(
      dbPath,
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name, type",
    ) as SchemaRow[]
  ).map((row) => `${row.type} ${row.name}: ${normalizedSql((row.sql ?? '').replace(/--[^\n]*/g, ''))}`);
  return new Bun.CryptoHasher('sha256').update(lines.join('\n')).digest('hex');
};

let templatePromise: Promise<string> | undefined;

// The populated store every `populatedShape` copies, built once per file through the public writer on
// first use (inside a test, never in a hook).
const populatedTemplate = (): Promise<string> => {
  templatePromise ??= (async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-migration-template-'));
    templateRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await populateThroughTheWriter(dbPath);
    return dbPath;
  })();
  return templatePromise;
};

/** A copy of the populated store, then `build` applied to it with raw SQL. */
const populatedShape = async (build?: (dbPath: string) => void | Promise<void>): Promise<string> => {
  const dbPath = await temporaryPath();
  await copyFile(await populatedTemplate(), dbPath);
  await build?.(dbPath);
  return dbPath;
};

/** A store file holding nothing but `sql`. */
const blankShape = async (sql: string): Promise<string> => {
  const dbPath = await temporaryPath();
  new Database(dbPath).close(true);
  execOn(sql)(dbPath);
  return dbPath;
};

const LEGACY_MARKER_SQL = `
  CREATE TABLE legacy_marker (value TEXT NOT NULL);
  INSERT INTO legacy_marker (value) VALUES ('preserved');
`;

const OUTBOX_OBJECTS = ['replication_outbox_events', 'replication_outbox_state'] as const;

// ---------------------------------------------------------------------------------------------------------

describe('a store created from nothing', () => {
  test('gets every table, index and trigger of schema 5 and its initial metadata', async () => {
    const dbPath = await temporaryPath();
    const { schema, ...outcome } = await migrateShape(dbPath);
    expect(outcome).toEqual(idempotent(true));
    expect(Object.keys(schema.tables)).toEqual([...FRESH_TABLES]);
    expect(Object.entries(schema.indexes).flatMap(([name, index]) => (index.sql === null ? [] : [name]))).toEqual([
      ...FRESH_INDEXES,
    ]);
    expect(Object.keys(schema.triggers)).toEqual([
      'usage_rows_invalidate_fleet_metadata_after_insert',
      'usage_rows_invalidate_fleet_metadata_after_update',
    ]);
    expect(schema.views).toEqual([]);
    expect(metadataOf(dbPath)).toEqual({
      generation: 0,
      machine_fleet_generation: 0,
      'migration.machine-fleet-metadata-v1': 1,
      'migration.machine-fleet-order-v1': 1,
      'migration.merge-row-v3-vcs': 1,
      'migration.rtk-contributions-v1': 1,
    });
  });

  // Tripwire. Every other shape is compared with a fresh store built by the same code, so a change to the
  // fresh DDL alone (a CHECK dropped from `usage_rows`, a new NOT NULL column) passes all of them while
  // existing stores keep the old definition. This digest of the fresh store's DDL text forces the question
  // the comparison cannot ask. It is one line on purpose: the DDL diff itself is reviewed in the source.
  test('the fresh schema DDL is the one whose convergence the shapes in this file prove', async () => {
    const dbPath = await temporaryPath();
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const digest = freshSchemaDigest(dbPath);
    expect(
      digest,
      'The fresh schema changed. Existing stores do not get this change unless a migration step carries it. ' +
        'Add or extend a legacy shape in migration-outcomes.test.ts that proves an existing store converges ' +
        '(an additive `ALTER TABLE ... ADD COLUMN` cannot carry a CHECK, a NOT NULL without default, or a ' +
        'foreign key: see the work_fact_run_state rebuild), then update FRESH_SCHEMA_DIGEST to the received value.',
    ).toBe(FRESH_SCHEMA_DIGEST);
  });
});

describe('schema 0 stores', () => {
  test('a foreign table is kept beside the created schema, with its rows', async () => {
    const dbPath = await blankShape(`${LEGACY_MARKER_SQL} PRAGMA user_version = 0;`);
    const { schema, ...outcome } = await migrateShape(dbPath);
    expect(outcome).toEqual(idempotent(true));
    expect(schemaDifferences(schema, await freshSchema())).toEqual(['+ table legacy_marker']);
    expect(rowsOf(dbPath, 'SELECT value FROM legacy_marker')).toEqual([{ value: 'preserved' }]);
  });

  test('a view named like a served table fails with migration-failure and leaves the store untouched', async () => {
    const dbPath = await blankShape(`
      ${LEGACY_MARKER_SQL}
      CREATE VIEW served_report_rows AS SELECT 1 AS incompatible;
      PRAGMA user_version = 0;
    `);
    const { failure, storeAfter, storeBefore } = await failWriterOpen(dbPath);
    expect(storeAfter).toEqual(storeBefore);
    expect(failure).toMatchObject({ operation: 'openUsageStoreWriter', reason: 'migration-failure' });
    expect(failure.message).toBe(`openUsageStoreWriter ${dbPath}: views may not be indexed`);
    expect(failure.cause).toMatchObject({ code: 'SQLITE_ERROR', name: 'SQLiteError' });
    expect(userVersionOf(dbPath)).toBe(0);
  });
});

describe('schema versions', () => {
  test('a populated schema 5 store is reopened without any change', async () => {
    const dbPath = await populatedShape();
    const before = tableRowsOf(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(false));
    expect(tableRowsOf(dbPath)).toEqual(before);
  });

  test('schema 4 drops the replication outbox and its rows, nothing else', async () => {
    const dbPath = await populatedShape(execOn(SCHEMA_FOUR_OUTBOX_SQL));
    const before = tableRowsOf(dbPath);
    expect(before.replication_outbox_events).toHaveLength(2);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(tableRowsOf(dbPath)).toEqual(withoutTables(before, OUTBOX_OBJECTS));
  });

  test('schema 3 is raised to 5 with its rows unchanged', async () => {
    const dbPath = await populatedShape(execOn('PRAGMA user_version = 3'));
    const before = tableRowsOf(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(tableRowsOf(dbPath)).toEqual(before);
  });

  test('schema 1 without the local machine projection gets an empty one', async () => {
    const dbPath = await populatedShape(execOn('DROP TABLE usage_local_machine; PRAGMA user_version = 1;'));
    const before = tableRowsOf(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM usage_local_machine')).toEqual([]);
    expect(withoutTables(tableRowsOf(dbPath), ['usage_local_machine'])).toEqual(before);
  });

  test('schema 6 fails with schema-too-new and leaves the store untouched', async () => {
    const dbPath = await populatedShape(execOn('PRAGMA user_version = 6'));
    const { failure, storeAfter, storeBefore } = await failWriterOpen(dbPath);
    expect(storeAfter).toEqual(storeBefore);
    expect(failure).toMatchObject({ operation: 'openUsageStoreWriter', reason: 'schema-too-new' });
    expect(failure.message).toBe(
      `openUsageStoreWriter ${dbPath}: Usage store schema 6 is newer than supported schema ${USAGE_STORE_SCHEMA_VERSION}`,
    );
    expect(failure.cause).toBeInstanceOf(UsageStoreSchemaTooNewError);
    expect(userVersionOf(dbPath)).toBe(6);
  });

  test('schema 2 with an older served projection fails with migration-failure and leaves the store untouched', async () => {
    const dbPath = await populatedShape(
      execOn(`
        DROP INDEX idx_served_report_rows_local_time_cell;
        ALTER TABLE served_report_rows DROP COLUMN local_time_weekday;
        ALTER TABLE served_report_rows DROP COLUMN local_time_hour;
        ALTER TABLE served_report_rows DROP COLUMN harness_provider_key;
        ALTER TABLE served_report_rows DROP COLUMN lines_measured;
        PRAGMA user_version = 2;
      `),
    );
    const { failure, storeAfter, storeBefore } = await failWriterOpen(dbPath);
    expect(storeAfter).toEqual(storeBefore);
    expect(failure).toMatchObject({ operation: 'openUsageStoreWriter', reason: 'migration-failure' });
    expect(failure.message).toBe(`openUsageStoreWriter ${dbPath}: no such column: local_time_weekday`);
    expect(userVersionOf(dbPath)).toBe(2);
    expect(rowsOf(dbPath, 'SELECT revision FROM served_report_current')).toEqual([
      { revision: 'characterization-revision' },
    ]);
  });

  test.each([
    { name: 'schema 1', sql: `${LOCAL_MACHINE_WITHOUT_CHECK_SQL} PRAGMA user_version = 1;`, userVersion: 1 },
    { name: 'schema 4', sql: `${SCHEMA_FOUR_OUTBOX_SQL} ${LOCAL_MACHINE_WITHOUT_CHECK_SQL}`, userVersion: 4 },
  ])(
    '$name with a same-name local machine table without its CHECK fails and rolls back everything',
    async ({ sql, userVersion }) => {
      const dbPath = await populatedShape(execOn(sql));
      const { failure, storeAfter, storeBefore } = await failWriterOpen(dbPath);
      expect(storeAfter).toEqual(storeBefore);
      expect(failure).toMatchObject({ operation: 'openUsageStoreWriter', reason: 'migration-failure' });
      expect(failure.message).toBe(
        `openUsageStoreWriter ${dbPath}: The local machine projection schema is incompatible.`,
      );
      expect(userVersionOf(dbPath)).toBe(userVersion);
    },
  );
});

describe('provider quota read projections', () => {
  test('missing projections are rebuilt to exactly what the writer maintained', async () => {
    const dbPath = await populatedShape();
    const maintained = {
      heads: rowsOf(dbPath, 'SELECT * FROM provider_quota_latest_heads'),
      streams: rowsOf(dbPath, 'SELECT * FROM provider_quota_streams'),
    };
    execOn('DROP TABLE provider_quota_latest_heads; DROP TABLE provider_quota_streams;')(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM provider_quota_streams')).toEqual([
      {
        account_scope: null,
        account_scope_key: 'n:',
        machine_id: MACHINE.id,
        provider_key: 'codex',
        source_key: 'poll',
      },
    ]);
    expect(rowsOf(dbPath, 'SELECT * FROM provider_quota_latest_heads')).toEqual([
      {
        account_scope_key: '',
        confidence_rank: 0,
        first_observed_at: '2026-10-20T09:30:00.000Z',
        machine_id: MACHINE.id,
        observation_id: 1,
        provider_key: 'codex',
      },
    ]);
    expect({
      heads: rowsOf(dbPath, 'SELECT * FROM provider_quota_latest_heads'),
      streams: rowsOf(dbPath, 'SELECT * FROM provider_quota_streams'),
    }).toEqual(maintained);
  });

  test('rebuilt heads rank by confidence, then the latest first observation, then the highest id, per account scope', async () => {
    const observation = (id: number, scope: string | null, source: string, confidence: string, observedAt: string) =>
      `(${id}, 'codex', 'Codex', ${scope === null ? 'NULL' : `'${scope}'`}, '${MACHINE.id}', NULL, '${source}', 'poll',
        '${confidence}', NULL, 'ok', NULL, NULL, '${observedAt}', '${observedAt}', 'hash-${id}')`;
    // Beside the populated observation 1 (no scope, authoritative, 09:30): a newer derived one without a
    // scope from another source, and for one account scope derived observations tied on time (3 and 4), an
    // older derived one (5) and a newer historical one (6).
    const dbPath = await populatedShape(
      execOn(`
        INSERT INTO provider_quota_observations (
          id, provider_key, provider_label, account_scope, machine_id, machine_label, source_key, source_mode,
          source_confidence, source_event_key, state, plan, provider_generated_at, first_observed_at,
          last_observed_at, content_hash
        ) VALUES
          ${observation(2, null, 'push', 'derived', '2026-10-20T11:00:00.000Z')},
          ${observation(3, 'account-a', 'poll', 'derived', '2026-10-20T10:00:00.000Z')},
          ${observation(4, 'account-a', 'poll', 'derived', '2026-10-20T10:00:00.000Z')},
          ${observation(5, 'account-a', 'poll', 'derived', '2026-10-20T09:00:00.000Z')},
          ${observation(6, 'account-a', 'poll', 'historical', '2026-10-20T12:00:00.000Z')};
        DROP TABLE provider_quota_latest_heads;
        DROP TABLE provider_quota_streams;
      `),
    );
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    const stream = (accountScope: string | null, sourceKey: string) => ({
      account_scope: accountScope,
      account_scope_key: accountScope === null ? 'n:' : `s:${accountScope}`,
      machine_id: MACHINE.id,
      provider_key: 'codex',
      source_key: sourceKey,
    });
    expect(rowsOf(dbPath, 'SELECT * FROM provider_quota_streams ORDER BY account_scope_key, source_key')).toEqual([
      stream(null, 'poll'),
      stream(null, 'push'),
      stream('account-a', 'poll'),
    ]);
    // The heads key the scope as the writer does (`account_scope ?? ''`), not as the streams do.
    expect(rowsOf(dbPath, 'SELECT * FROM provider_quota_latest_heads ORDER BY account_scope_key')).toEqual([
      {
        account_scope_key: '',
        confidence_rank: 0,
        first_observed_at: '2026-10-20T09:30:00.000Z',
        machine_id: MACHINE.id,
        observation_id: 1,
        provider_key: 'codex',
      },
      {
        account_scope_key: 'account-a',
        confidence_rank: 1,
        first_observed_at: '2026-10-20T10:00:00.000Z',
        machine_id: MACHINE.id,
        observation_id: 4,
        provider_key: 'codex',
      },
    ]);
  });

  test('history over the stream read budget fails with migration-failure and leaves the store untouched', async () => {
    const dbPath = await populatedShape(execOn(QUOTA_OVER_STREAM_BUDGET_SQL));
    const { failure, storeAfter, storeBefore } = await failWriterOpen(dbPath);
    expect(storeAfter).toEqual(storeBefore);
    expect(failure).toMatchObject({ operation: 'openUsageStoreWriter', reason: 'migration-failure' });
    expect(failure.message).toBe(
      `openUsageStoreWriter ${dbPath}: Provider quota history exceeds its ${MAX_PROVIDER_QUOTA_STREAMS}-stream read budget`,
    );
    expect(Object.keys(schemaOf(dbPath).tables)).not.toContain('provider_quota_streams');
  });
});

describe('skill observation collection state', () => {
  const backfilledState = (machineId: string, harnessKey: string) => ({
    collected_at: FROZEN_NOW,
    exposure_rejected: 0,
    exposure_truncated: 0,
    harness_key: harnessKey,
    invocation_rejected: 0,
    invocation_truncated: 1,
    machine_id: machineId,
  });

  test('a store without the skill family gets it, with every locally observed pair marked incomplete', async () => {
    const dbPath = await populatedShape(
      execOn('DROP TABLE skill_observations; DROP TABLE skill_observation_collection_state;'),
    );
    const generation = metadataOf(dbPath).generation ?? Number.NaN;
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM skill_observations')).toEqual([]);
    expect(rowsOf(dbPath, 'SELECT * FROM skill_observation_collection_state')).toEqual([
      backfilledState(MACHINE.id, 'claude'),
    ]);
    expect(metadataOf(dbPath).generation).toBe(generation + 1);
  });

  // A copy of the populated Claude row under another key, machine, harness and source authority.
  const usageRowLike = (rowKey: string, machineId: string, harnessKey: string, authority: string): string => `
    INSERT INTO usage_rows (
      origin_machine_id, harness_key, source_session_id, source_fingerprint, source_authority, row_key,
      content_hash, row_json, machine_label, fleet_metadata_valid, status, active_date, project, model,
      token_total, first_seen_at, last_seen_at, updated_at
    )
    SELECT
      '${machineId}', '${harnessKey}', source_session_id, source_fingerprint, '${authority}', '${rowKey}',
      content_hash, row_json, machine_label, fleet_metadata_valid, status, active_date, project, model,
      token_total, first_seen_at, last_seen_at, updated_at
    FROM usage_rows WHERE row_key = '${CLAUDE_ROW_KEY}';
  `;
  // Rows the backfill must ignore: a portable (not locally observed) row of an observable harness, and a
  // locally observed row of a harness that records no skill invocation.
  const IGNORED_USAGE_ROWS_SQL = `
    ${usageRowLike('portable-codex-row', 'machine-portable', 'codex', 'portable-opaque')}
    ${usageRowLike('local-cursor-row', 'machine-cursor', 'cursor', 'local-observed')}
  `;

  test('a missing collection state is backfilled from local usage rows and observations of observable harnesses', async () => {
    const dbPath = await populatedShape(
      execOn(`
        DROP TABLE skill_observation_collection_state;
        INSERT INTO skill_observations (harness_key, skill_name, tier, machine_id, session_id, observation_key,
          observed_at, first_observed_at, last_observed_at)
        VALUES
          ('codex', 'skill', 'declared', 'machine-b', 'session-b', 'call-b', '${FROZEN_NOW}', '${FROZEN_NOW}', '${FROZEN_NOW}'),
          ('cursor', 'skill', 'declared', 'machine-c', 'session-c', 'call-c', '${FROZEN_NOW}', '${FROZEN_NOW}', '${FROZEN_NOW}');
        ${IGNORED_USAGE_ROWS_SQL}
      `),
    );
    const generation = metadataOf(dbPath).generation ?? Number.NaN;
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    // Not machine-portable (portable row), machine-c (cursor observation) or machine-cursor (cursor row).
    expect(rowsOf(dbPath, 'SELECT * FROM skill_observation_collection_state ORDER BY machine_id')).toEqual([
      backfilledState(MACHINE.id, 'claude'),
      backfilledState('machine-b', 'codex'),
    ]);
    expect(metadataOf(dbPath).generation).toBe(generation + 1);
  });

  test('a missing collection state with nothing to backfill stays empty and leaves the generation alone', async () => {
    const dbPath = await populatedShape(
      execOn(`
        DROP TABLE skill_observation_collection_state;
        DELETE FROM skill_observations;
        ${IGNORED_USAGE_ROWS_SQL}
        DELETE FROM usage_rows WHERE row_key = '${CLAUDE_ROW_KEY}';
      `),
    );
    const generation = metadataOf(dbPath).generation ?? Number.NaN;
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM skill_observation_collection_state')).toEqual([]);
    expect(metadataOf(dbPath).generation).toBe(generation);
  });
});

describe('executor observations', () => {
  test('a missing table is created empty', async () => {
    const dbPath = await populatedShape(execOn('DROP TABLE executor_observations;'));
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM executor_observations')).toEqual([]);
  });

  test.each([
    {
      expected: { account_fingerprint: null, auth_method: null, harness: 'codex', version: 'codex-cli 0.163.0' },
      name: 'the first version gains the sign-in method and the account fingerprint',
      sql: EXECUTOR_FIRST_VERSION_SQL,
    },
    {
      expected: {
        account_fingerprint: null,
        auth_method: 'claude.ai',
        harness: 'claude-code',
        version: '2.1.306 (Claude Code)',
      },
      name: 'a table without the fingerprint gains it, older rows read as none',
      sql: EXECUTOR_WITHOUT_FINGERPRINT_SQL,
    },
  ])('$name', async ({ expected, sql }) => {
    const dbPath = await populatedShape(execOn(sql));
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(
      rowsOf(dbPath, 'SELECT account_fingerprint, auth_method, harness, version FROM executor_observations'),
    ).toEqual([expected]);
  });

  test('a missing account-change barrier is rebuilt from the retained history, as the writer recorded it', async () => {
    const dbPath = await populatedShape();
    const recorded = rowsOf(dbPath, 'SELECT * FROM executor_account_changes ORDER BY harness');
    expect(recorded).toEqual([
      {
        account_fingerprint: 'fedcba9876543210',
        changed_at: '2026-10-25T09:00:00.000Z',
        harness: 'claude-code',
        machine_id: MACHINE.id,
        observed_at: '2026-10-25T09:00:00.000Z',
      },
    ]);
    execOn('DROP TABLE executor_account_changes;')(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM executor_account_changes ORDER BY harness')).toEqual(recorded);
  });
});

describe('families added under the same version', () => {
  test.each([
    {
      name: 'delegation tables',
      sql: 'DROP TABLE delegation_evaluations; DROP TABLE delegation_jobs; DROP TABLE delegation_qualifications;',
      tables: ['delegation_evaluations', 'delegation_jobs', 'delegation_qualifications'],
    },
    {
      name: 'Claude Desktop session family',
      sql: 'DROP TABLE claude_desktop_sessions; DROP TABLE claude_desktop_collection_state; DROP TABLE claude_desktop_turn_declarations;',
      tables: ['claude_desktop_collection_state', 'claude_desktop_sessions', 'claude_desktop_turn_declarations'],
    },
    {
      name: 'Codex work tables',
      sql: 'DROP TABLE codex_work_observations; DROP TABLE codex_work_collection_coverage;',
      tables: ['codex_work_collection_coverage', 'codex_work_observations'],
    },
    {
      name: 'Work thread tables',
      sql: 'DROP TABLE work_thread_combinations; DROP TABLE work_jira_intake; DROP TABLE work_thread_commands; DROP TABLE work_thread_events; DROP TABLE work_thread_links; DROP TABLE work_threads',
      tables: [
        'work_jira_intake',
        'work_thread_combinations',
        'work_thread_commands',
        'work_thread_events',
        'work_thread_links',
        'work_threads',
      ],
    },
  ])('missing $name are created empty, other rows unchanged', async ({ sql, tables }) => {
    const dbPath = await populatedShape(execOn(sql));
    const before = tableRowsOf(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    const after = tableRowsOf(dbPath);
    for (const table of tables) {
      expect(after[table]).toEqual([]);
    }
    expect(withoutTables(after, tables)).toEqual(before);
  });

  test('a Claude Desktop family before the declaration history and the message time gains both; the session reads no message time', async () => {
    const dbPath = await populatedShape(
      execOn(
        'DROP TABLE claude_desktop_turn_declarations; ALTER TABLE claude_desktop_sessions DROP COLUMN latest_user_frame_at;',
      ),
    );
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT desktop_session_id, latest_user_frame_at FROM claude_desktop_sessions')).toEqual([
      { desktop_session_id: 'local_characterization', latest_user_frame_at: null },
    ]);
    expect(rowsOf(dbPath, 'SELECT * FROM claude_desktop_turn_declarations')).toEqual([]);
  });

  test('a pull request table from before R2 gains the discovery and history columns and keeps its rows', async () => {
    const dbPath = await populatedShape(execOn(PULL_REQUESTS_BEFORE_R2_SQL));
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(
      rowsOf(
        dbPath,
        'SELECT id, number, title, discovery_role, created_at, history, cross_repository FROM pull_request_observations ORDER BY id',
      ),
    ).toEqual([
      {
        created_at: null,
        cross_repository: null,
        discovery_role: 'author',
        history: null,
        id: 11,
        number: 11,
        title: 'Historical PR 11',
      },
      {
        created_at: null,
        cross_repository: null,
        discovery_role: 'author',
        history: null,
        id: 12,
        number: 12,
        title: 'Historical PR 12',
      },
    ]);
  });

  test.each([
    {
      name: 'pull request discovery columns',
      sql: `
        ALTER TABLE pull_request_observations DROP COLUMN discovery_role;
        ALTER TABLE pull_request_observations DROP COLUMN mergeable;
        ALTER TABLE pull_request_observations DROP COLUMN merge_state_status;
      `,
    },
    {
      name: 'Jira columns and sync state',
      sql: `
        ALTER TABLE jira_issue_observations DROP COLUMN url;
        ALTER TABLE jira_issue_observations DROP COLUMN handed_off;
        DROP TABLE jira_sync_state;
      `,
    },
  ])('missing $name are added', async ({ sql }) => {
    const dbPath = await populatedShape(execOn(sql));
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
  });
});

// `migrateWorkFactSchema` adds a missing `outcome_code` with a bare `ALTER TABLE ... ADD COLUMN`, which does
// not carry the CHECK a fresh store declares; `rebuildWorkFactRunStateForOutcomeCode` then rebuilds a table
// whose stored definition lacks that CHECK, copying every row the CHECK accepts.
describe('work fact run state from before the outcome code', () => {
  const OUTCOME_CODE_CHECK = "CHECK (outcome_code IS NULL OR outcome_code = 'unauthenticated')";
  // The table as `b6bf3074` (2026-10-21, Work resume branches) created it and `4088634a` (2026-10-25, PR #67)
  // brought it to main, verbatim: no outcome_code column.
  const FIRST_VERSION_SQL = `
    DROP TABLE work_fact_run_state;
    CREATE TABLE IF NOT EXISTS work_fact_run_state (
      source_id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      ran_at TEXT NOT NULL,
      observed INTEGER NOT NULL CHECK (observed >= 0),
      failed INTEGER NOT NULL CHECK (failed >= 0),
      disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
      message TEXT
    ) WITHOUT ROWID;
  `;
  // The same table after any open by a build that has the column, before this rebuild existed: from
  // `6033c2d5` (2026-10-24) on the `work-unit-*` branches, from `fbb8c50b` (2026-10-26, PR #74) on main. Such a
  // build declares the CHECK only in its fresh definition; its additive step's own statement appended the
  // column to the existing table without it. The real-world shape.
  const COLUMN_WITHOUT_CHECK_SQL = `${FIRST_VERSION_SQL} ALTER TABLE work_fact_run_state ADD COLUMN outcome_code TEXT;`;
  const storedDefinitionOf = (dbPath: string): string => {
    const [row] = rowsOf(dbPath, "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'work_fact_run_state'");
    if (typeof row !== 'object' || row === null || !('sql' in row) || typeof row.sql !== 'string') {
      throw new Error('work_fact_run_state has no stored definition.');
    }
    return row.sql;
  };
  // Every column the table has, of every row, as an SQL literal (`quote()`), so a changed storage class
  // shows too.
  const storedRunsOf = (dbPath: string): Record<string, string>[] =>
    withDatabase(dbPath, (db) => {
      const columns = Object.keys(describeTable(db, { name: 'work_fact_run_state', sql: null, type: 'table' }).columns);
      return db
        .query(
          `SELECT ${columns.map((column) => `quote(${column}) AS ${column}`).join(', ')} FROM work_fact_run_state ORDER BY source_id`,
        )
        .all() as Record<string, string>[];
    });
  const sourceIdsOf = (dbPath: string): (string | undefined)[] => storedRunsOf(dbPath).map((row) => row.source_id);
  const evidenceColumnsMissing = (): Promise<string> =>
    populatedShape(
      execOn(
        'ALTER TABLE checkout_status_observations DROP COLUMN counts_changed_at; ALTER TABLE work_fact_run_state DROP COLUMN outcome_code;',
      ),
    );
  const insertRun = (dbPath: string, sourceId: string, outcomeCode: string | null): void =>
    withDatabase(dbPath, (db) => {
      db.query('INSERT INTO work_fact_run_state VALUES (?, ?, ?, 0, 0, 0, NULL, ?)').run(
        sourceId,
        MACHINE.id,
        FROZEN_NOW,
        outcomeCode,
      );
    });

  const recordRun = (dbPath: string, sourceId: 'github.pull-requests' | 'jira.issues', outcomeCode: string | null) =>
    Effect.runPromise(
      Effect.result(
        recordWorkFactRun({
          dbPath,
          disabled: false,
          failed: 0,
          machineId: MACHINE.id,
          message: null,
          observed: 1,
          // Deliberately unnarrowed: the writer's own validation is what is exercised.
          outcomeCode: outcomeCode as 'unauthenticated' | null,
          ranAt: FROZEN_NOW,
          sourceId,
        }),
      ),
    );

  test('the migrated store converges to the fresh schema and refuses an invalid outcome code as a fresh store does', async () => {
    const legacy = await evidenceColumnsMissing();
    expect(await migrationAgainstFresh(legacy)).toEqual(convergedToFresh(true));
    expect(checkClauses(storedDefinitionOf(legacy))).toContain(OUTCOME_CODE_CHECK);
    expect(() => insertRun(legacy, 'github.pull-requests', 'bogus')).toThrow('CHECK constraint failed');
    const fresh = await temporaryPath();
    await Effect.runPromise(initializeUsageStore({ dbPath: fresh }));
    expect(() => insertRun(fresh, 'github.pull-requests', 'bogus')).toThrow('CHECK constraint failed');
  });

  test('the writer still refuses an invalid outcome code and the reader reads the valid one', async () => {
    const dbPath = await evidenceColumnsMissing();
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    const refused = await recordRun(dbPath, 'github.pull-requests', 'bogus');
    expect(refused._tag === 'Failure' ? refused.failure.reason : refused).toBe('invalid-input');
    expect(rowsOf(dbPath, 'SELECT * FROM work_fact_run_state')).toEqual([]);
    expect((await recordRun(dbPath, 'github.pull-requests', 'unauthenticated'))._tag).toBe('Success');
    const states = await Effect.runPromise(queryWorkFactRunStates({ dbPath }));
    expect(states.runs.map((state) => [state.sourceId, state.outcomeCode])).toEqual([
      ['github.pull-requests', 'unauthenticated'],
    ]);
  });

  test('a table from before the column keeps every row, which reads no outcome code', async () => {
    const dbPath = await populatedShape(
      execOn(`${FIRST_VERSION_SQL}
        INSERT INTO work_fact_run_state VALUES ('github.pull-requests', '${MACHINE.id}', '${FROZEN_NOW}', 3, 1, 0, 'partial');
        INSERT INTO work_fact_run_state VALUES ('jira.issues', '${MACHINE.id}', '${FROZEN_NOW}', 0, 0, 1, NULL);
      `),
    );
    const before = storedRunsOf(dbPath);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(storedRunsOf(dbPath)).toEqual(before.map((row) => ({ ...row, outcome_code: 'NULL' })));
    expect(checkClauses(storedDefinitionOf(dbPath))).toContain(OUTCOME_CODE_CHECK);
  });

  test('a table with the column but not its CHECK is rebuilt: valid rows kept exactly, the invalid one dropped', async () => {
    const dbPath = await populatedShape(
      execOn(`${COLUMN_WITHOUT_CHECK_SQL}
        INSERT INTO work_fact_run_state VALUES
          ('checkouts.status', '${MACHINE.id}', '2026-10-30T07:00:00.000Z', 0, 0, 1, NULL, NULL),
          ('github.pull-requests', '${MACHINE.id}', '2026-10-31T08:00:00.000Z', 4, 2, 0, 'sign in', 'unauthenticated'),
          ('jira.issues', 'machine-other', '${FROZEN_NOW}', 1, 0, 0, 'odd', 'bogus');
      `),
    );
    const before = storedRunsOf(dbPath);
    expect(sourceIdsOf(dbPath)).toEqual(["'checkouts.status'", "'github.pull-requests'", "'jira.issues'"]);
    expect(checkClauses(storedDefinitionOf(dbPath))).not.toContain(OUTCOME_CODE_CHECK);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(storedRunsOf(dbPath)).toEqual(before.slice(0, 2));
    expect(schemaOf(dbPath).tables.work_fact_run_state?.withoutRowid).toBe(true);
    // The reader sees both kept rows and has nothing to skip.
    const states = await Effect.runPromise(queryWorkFactRunStates({ dbPath }));
    expect(states).toEqual({
      runs: [
        expect.objectContaining({ outcomeCode: null, sourceId: 'checkouts.status' }),
        expect.objectContaining({ outcomeCode: 'unauthenticated', sourceId: 'github.pull-requests' }),
      ],
      skipped: 0,
    });
    // The dropped row's source writes its row again on its next run.
    expect((await recordRun(dbPath, 'jira.issues', null))._tag).toBe('Success');
    expect(sourceIdsOf(dbPath)).toEqual(["'checkouts.status'", "'github.pull-requests'", "'jira.issues'"]);
  });

  test('a fresh store and an already converged store are not rebuilt', async () => {
    const fresh = await populatedShape();
    expect((await recordRun(fresh, 'github.pull-requests', 'unauthenticated'))._tag).toBe('Success');
    const freshDefinition = storedDefinitionOf(fresh);
    const freshRuns = storedRunsOf(fresh);
    expect(migrateOnBoundary(fresh)).toBe(false);
    expect(storedDefinitionOf(fresh)).toEqual(freshDefinition);
    expect(storedRunsOf(fresh)).toEqual(freshRuns);

    const converged = await populatedShape(
      execOn(`${COLUMN_WITHOUT_CHECK_SQL}
        INSERT INTO work_fact_run_state VALUES ('github.pull-requests', '${MACHINE.id}', '${FROZEN_NOW}', 1, 0, 0, NULL, 'unauthenticated');
      `),
    );
    expect(migrateOnBoundary(converged)).toBe(true);
    const convergedDefinition = storedDefinitionOf(converged);
    const convergedRuns = storedRunsOf(converged);
    expect(migrateOnBoundary(converged)).toBe(false);
    await Effect.runPromise(initializeUsageStore({ dbPath: converged }));
    expect(storedDefinitionOf(converged)).toEqual(convergedDefinition);
    expect(storedRunsOf(converged)).toEqual(convergedRuns);
  });
});

// `backfillSkillObservationCollectionState` reads `usage_rows.source_authority`, which `addUsageRowColumns`
// adds; the backfill runs directly after it. Before that order, a store whose usage_rows predates the column
// (last opened by a build older than `85b7c2a7`, 2026-07-15) and which has no skill collection state failed
// the writer open with `no such column: source_authority`. The added column gives every existing row its
// default `'portable-opaque'`, so for such a store only the skill observations name a pair to backfill; its
// usage rows, though locally collected, cannot be told apart from portable ones.
describe('a store from before source authority with no skill collection state', () => {
  const backfilledState = (machineId: string, harnessKey: string) => ({
    collected_at: FROZEN_NOW,
    exposure_rejected: 0,
    exposure_truncated: 0,
    harness_key: harnessKey,
    invocation_rejected: 0,
    invocation_truncated: 1,
    machine_id: machineId,
  });

  test('converges to the fresh schema, the pair its skill observation names marked incomplete', async () => {
    const dbPath = await populatedShape(
      execOn(`${USAGE_ROWS_BEFORE_FLEET_COLUMNS_SQL} DROP TABLE skill_observation_collection_state;`),
    );
    const generation = metadataOf(dbPath).generation ?? Number.NaN;
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT * FROM skill_observation_collection_state')).toEqual([
      backfilledState(MACHINE.id, 'claude'),
    ]);
    expect(rowsOf(dbPath, 'SELECT origin_machine_id, harness_key, source_authority FROM usage_rows')).toEqual([
      { harness_key: 'claude', origin_machine_id: MACHINE.id, source_authority: 'portable-opaque' },
    ]);
    expect(metadataOf(dbPath).generation).toBe(generation + 1);
  });

  test('backfills the observable pairs of its skill observations, never a pair only its usage rows name', async () => {
    const dbPath = await populatedShape(
      execOn(`${USAGE_ROWS_BEFORE_FLEET_COLUMNS_SQL}
        DROP TABLE skill_observation_collection_state;
        DELETE FROM skill_observations;
        INSERT INTO skill_observations (harness_key, skill_name, tier, machine_id, session_id, observation_key,
          observed_at, first_observed_at, last_observed_at)
        VALUES
          ('codex', 'skill', 'declared', 'machine-b', 'session-b', 'call-b', '${FROZEN_NOW}', '${FROZEN_NOW}', '${FROZEN_NOW}'),
          ('opencode', 'skill', 'exposed', 'machine-b', 'session-o', 'call-o', '${FROZEN_NOW}', '${FROZEN_NOW}', '${FROZEN_NOW}'),
          ('cursor', 'skill', 'declared', 'machine-c', 'session-c', 'call-c', '${FROZEN_NOW}', '${FROZEN_NOW}', '${FROZEN_NOW}');
      `),
    );
    const generation = metadataOf(dbPath).generation ?? Number.NaN;
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    // Not machine-c (cursor records no skill invocation), not the characterization machine (its Claude
    // usage row reads the added column's default, 'portable-opaque').
    expect(rowsOf(dbPath, 'SELECT * FROM skill_observation_collection_state ORDER BY machine_id, harness_key')).toEqual(
      [backfilledState('machine-b', 'codex'), backfilledState('machine-b', 'opencode')],
    );
    expect(metadataOf(dbPath).generation).toBe(generation + 1);
  });
});

// Every column an additive step adds with `ALTER TABLE ... ADD COLUMN`: `addUsageRowColumns`,
// `migrateExecutorObservations` and `addClaudeDesktopMessageTime` in `migration.ts`, `ADDED_COLUMNS` in
// `review-attempt-schema.ts` and the additions of `migrateWorkFactSchema` in `work-fact-schema.ts`.
const ADDITIVE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  checkout_status_observations: ['counts_changed_at'],
  claude_desktop_sessions: ['latest_user_frame_at'],
  executor_observations: ['auth_method', 'account_fingerprint'],
  jira_issue_observations: ['url', 'handed_off'],
  pull_request_observations: [
    'discovery_role',
    'mergeable',
    'merge_state_status',
    'created_at',
    'closed_at',
    'unresolved_review_threads',
    'cross_repository',
    'history',
  ],
  review_attempts: [
    'launch_session_id',
    'released_at',
    'release_evidence',
    'scope_json',
    'guarantee_json',
    'base_sha',
    'head_sha',
    'native_turn_id',
    'stop_requested_at',
    'stop_confirmed_at',
  ],
  usage_rows: ['source_authority', 'machine_label', 'fleet_metadata_valid'],
  work_fact_run_state: ['outcome_code'],
};

describe('every column an additive migration adds', () => {
  test('keeps the type, NOT NULL, DEFAULT, CHECK, COLLATE and foreign keys of the fresh DDL', async () => {
    const dbPath = await populatedShape(
      execOn(`
        DROP TRIGGER usage_rows_invalidate_fleet_metadata_after_insert;
        DROP TRIGGER usage_rows_invalidate_fleet_metadata_after_update;
        DROP INDEX idx_usage_rows_fleet;
        DROP INDEX idx_review_attempts_reserved_identity;
        ${Object.entries(ADDITIVE_COLUMNS)
          .flatMap(([table, columns]) => columns.map((column) => `ALTER TABLE ${table} DROP COLUMN ${column};`))
          .join('\n')}
      `),
    );
    const before = schemaOf(dbPath);
    for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
      expect(Object.keys(before.tables[table]?.columns ?? {})).not.toEqual(expect.arrayContaining([...columns]));
    }
    const { schema, ...outcome } = await migrateShape(dbPath);
    expect(outcome).toEqual(idempotent(true));
    expect(schemaDifferences(schema, await freshSchema())).toEqual([]);
  });
});

describe('review attempts', () => {
  test('the first version gains every column; its lost rows are released as recorded before reservations', async () => {
    const dbPath = await populatedShape(execOn(REVIEW_ATTEMPTS_FIRST_VERSION_SQL));
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(
      rowsOf(
        dbPath,
        'SELECT attempt_id, state, released_at, release_evidence FROM review_attempts ORDER BY attempt_id',
      ),
    ).toEqual([
      { attempt_id: 'live-1', release_evidence: null, released_at: null, state: 'running' },
      {
        attempt_id: 'lost-1',
        release_evidence: 'recorded-before-reservations',
        released_at: '2026-10-22T10:00:15.000Z',
        state: 'lost',
      },
      {
        attempt_id: 'lost-2',
        release_evidence: 'recorded-before-reservations',
        released_at: '2026-10-22T10:01:00.000Z',
        state: 'lost',
      },
    ]);
  });

  test.each([
    {
      name: 'the reservation version is rebuilt under the current release evidence check',
      values: "'process-absent', 'outcome-recorded-late', 'recorded-before-reservations'",
    },
    {
      name: 'the operator-release version is rebuilt under the current release evidence check',
      values: "'process-absent', 'outcome-recorded-late', 'recorded-before-reservations', 'operator-declared-ended'",
    },
  ])('$name, every row copied', async ({ values }) => {
    const dbPath = await populatedShape(execOn(reviewAttemptsWithReleaseEvidence(values)));
    const before = rowsOf(
      dbPath,
      'SELECT attempt_id, state, released_at, release_evidence, scope_json FROM review_attempts ORDER BY attempt_id',
    );
    expect(before).toHaveLength(2);
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(
      rowsOf(
        dbPath,
        'SELECT attempt_id, state, released_at, release_evidence, scope_json FROM review_attempts ORDER BY attempt_id',
      ),
    ).toEqual(before);
  });

  test('a table without the stop evidence columns gains them', async () => {
    const dbPath = await populatedShape(
      execOn(
        'ALTER TABLE review_attempts DROP COLUMN native_turn_id; ALTER TABLE review_attempts DROP COLUMN stop_requested_at; ALTER TABLE review_attempts DROP COLUMN stop_confirmed_at;',
      ),
    );
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
  });
});

describe('usage rows', () => {
  test('rows awaiting every row-level migration are rewritten once, the unparseable one left as it is', async () => {
    const dbPath = await populatedShape(shapeLegacyRows);
    const before = {
      generation: metadataOf(dbPath).generation ?? Number.NaN,
      unparseable: rowsOf(dbPath, "SELECT * FROM usage_rows WHERE row_key = 'unparseable-row-key'"),
    };
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    // Merge rows to VCS: the pre-VCS row now carries today's fingerprint, hash and JSON.
    const current = toSerializedMergeRow(codexRow('pre-vcs-row'), MACHINE);
    const [migrated] = rowsOf(
      dbPath,
      `SELECT source_fingerprint, content_hash, row_json, updated_at FROM usage_rows WHERE row_key = '${current.rowKey}'`,
    ) as Array<{ content_hash: string; row_json: string; source_fingerprint: string; updated_at: string }>;
    expect(migrated?.source_fingerprint).toBe(current.sourceFingerprint);
    expect(migrated?.content_hash).toBe(current.contentHash);
    expect(JSON.parse(migrated?.row_json ?? 'null')).toEqual(current);
    expect(migrated?.updated_at).toBe(FROZEN_NOW);
    // RTK contributions: the embedded savings become an enrichment row, also for the pre-VCS row, which
    // the RTK step can only read after the VCS step rewrote it.
    const rtkRowKey = toSerializedMergeRow(codexRow('legacy-rtk'), MACHINE).rowKey;
    const preVcsRtk = toSerializedMergeRow(withEmbeddedRtk(codexRow('pre-vcs-rtk')), MACHINE);
    const enrichment = (rowKey: string) => ({
      content_hash: enrichmentContentHash(RTK_CONTRIBUTION),
      first_seen_at: FROZEN_NOW,
      last_seen_at: FROZEN_NOW,
      payload_json: JSON.stringify(RTK_CONTRIBUTION),
      row_key: rowKey,
      schema_version: RTK_SAVINGS_SCHEMA_VERSION,
      source_id: RTK_SAVINGS_SOURCE_ID,
      updated_at: FROZEN_NOW,
    });
    expect(rowsOf(dbPath, `SELECT * FROM usage_row_enrichments WHERE row_key = '${rtkRowKey}'`)).toEqual([
      enrichment(rtkRowKey),
    ]);
    expect(
      rowsOf(dbPath, `SELECT row_json FROM usage_rows WHERE row_key = '${preVcsRtk.rowKey}'`).map((row) =>
        JSON.parse((row as { row_json: string }).row_json),
      ),
    ).toEqual([preVcsRtk]);
    expect(rowsOf(dbPath, `SELECT * FROM usage_row_enrichments WHERE row_key = '${preVcsRtk.rowKey}'`)).toEqual([
      enrichment(preVcsRtk.rowKey),
    ]);
    // Machine fleet metadata: valid rows carry their machine label, the unparseable row is invalid.
    const fleet = rowsOf(dbPath, 'SELECT row_key, machine_label, fleet_metadata_valid FROM usage_rows') as Array<{
      fleet_metadata_valid: number;
      machine_label: string;
      row_key: string;
    }>;
    expect(fleet.map(({ row_key }) => row_key).sort()).toEqual(
      [CLAUDE_ROW_KEY, current.rowKey, rtkRowKey, preVcsRtk.rowKey, 'unparseable-row-key'].sort(),
    );
    for (const row of fleet) {
      expect(row).toEqual(
        row.row_key === 'unparseable-row-key'
          ? { fleet_metadata_valid: 0, machine_label: '', row_key: row.row_key }
          : { fleet_metadata_valid: 1, machine_label: MACHINE.label, row_key: row.row_key },
      );
    }
    expect(rowsOf(dbPath, "SELECT * FROM usage_rows WHERE row_key = 'unparseable-row-key'")).toEqual(
      (before.unparseable as Record<string, unknown>[]).map((row) => ({
        ...row,
        fleet_metadata_valid: 0,
        machine_label: '',
      })),
    );
    // Machine fleet order and the markers.
    expect(rowsOf(dbPath, 'SELECT * FROM usage_machine_fleet_order')).toEqual([
      { machine_label: MACHINE.label, origin_machine_id: MACHINE.id, sort_rank: 0 },
    ]);
    expect(metadataOf(dbPath)).toMatchObject({
      generation: before.generation + 1,
      'migration.machine-fleet-metadata-v1': 1,
      'migration.machine-fleet-order-v1': 1,
      'migration.merge-row-v3-vcs': 1,
      'migration.rtk-contributions-v1': 1,
    });
  });

  test('rows from before source authority and fleet metadata gain the columns, their metadata and the fleet order', async () => {
    const dbPath = await populatedShape(
      execOn(`${USAGE_ROWS_BEFORE_FLEET_COLUMNS_SQL} DELETE FROM usage_machine_fleet_order;`),
    );
    expect(await migrationAgainstFresh(dbPath)).toEqual(convergedToFresh(true));
    expect(rowsOf(dbPath, 'SELECT source_authority, machine_label, fleet_metadata_valid FROM usage_rows')).toEqual([
      { fleet_metadata_valid: 1, machine_label: MACHINE.label, source_authority: 'portable-opaque' },
    ]);
    expect(rowsOf(dbPath, 'SELECT * FROM usage_machine_fleet_order')).toEqual([
      { machine_label: MACHINE.label, origin_machine_id: MACHINE.id, sort_rank: 0 },
    ]);
  });
});
