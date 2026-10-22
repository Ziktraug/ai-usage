import { createHash } from 'node:crypto';
import {
  type CodexWorkObservation,
  parseCodexWorkObservation,
  type StoredCodexWorkObservation,
} from '@ai-usage/report-core/codex-work-observation';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import { Effect } from 'effect';
import type { UsageStoreError, UsageStoreErrorReason } from './errors';

export const MAX_CODEX_WORK_BATCH = 10_000;
export const MAX_CODEX_WORK_SESSION_FILTER = 500;
export const CODEX_WORK_TABLES = ['codex_work_observations'] as const;

/** Auxiliary local evidence, excluded from report generations, snapshots and replication. */
export const codexWorkSchemaSql = `
  CREATE TABLE IF NOT EXISTS codex_work_observations (
    machine_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    last_event_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    PRIMARY KEY (machine_id, source_session_id)
  ) WITHOUT ROWID;
`;

interface SqliteDatabase {
  exec(sql: string): unknown;
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

interface CodexWorkStoreDependencies {
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

export interface ImportCodexWorkObservationsInput {
  readonly dbPath: string;
  readonly machineId: string;
  readonly observations: readonly unknown[];
  readonly observedAt: string;
}

export interface QueryCodexWorkObservationsInput {
  readonly dbPath: string;
  readonly machineId: string;
  readonly sourceSessionIds: readonly string[];
}

export interface CodexWorkImportResult {
  readonly changed: number;
  readonly rejected: number;
  readonly unchanged: number;
}

export interface CodexWorkQueryResult {
  readonly observations: readonly StoredCodexWorkObservation[];
  readonly skipped: number;
}

const CONTROL_CHARACTERS = /\p{Cc}/u;
const validId = (value: string): boolean =>
  value.trim().length > 0 && value.length <= 256 && !CONTROL_CHARACTERS.test(value);

export const createCodexWorkStore = (dependencies: CodexWorkStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;
  const importCodexWorkObservations = (
    input: ImportCodexWorkObservationsInput,
  ): Effect.Effect<CodexWorkImportResult, UsageStoreError> => {
    const observedAt = normalizeIsoTimestamp(input.observedAt);
    if (!validId(input.machineId) || observedAt === null || input.observations.length > MAX_CODEX_WORK_BATCH) {
      return Effect.fail(
        usageStoreError(
          'importCodexWorkObservations',
          input.dbPath,
          'Invalid or over-bound Codex work import',
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          let changed = 0;
          let unchanged = 0;
          let rejected = 0;
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const candidate of input.observations) {
              const observation = parseCodexWorkObservation(candidate);
              if (observation === null || observation.lastEventAt > observedAt) {
                rejected++;
                continue;
              }
              const json = JSON.stringify(observation);
              const hash = createHash('sha256').update(json).digest('hex');
              const previous = db
                .query(
                  'SELECT content_hash, last_event_at FROM codex_work_observations WHERE machine_id = ? AND source_session_id = ?',
                )
                .get(input.machineId, observation.sourceSessionId);
              if (
                isRecord(previous) &&
                (previous.content_hash === hash ||
                  (typeof previous.last_event_at === 'string' && previous.last_event_at > observation.lastEventAt))
              ) {
                unchanged++;
                continue;
              }
              db.query(`INSERT INTO codex_work_observations (machine_id, source_session_id, observed_at, last_event_at, content_hash, observation_json)
              VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(machine_id, source_session_id) DO UPDATE SET
                observed_at = excluded.observed_at, last_event_at = excluded.last_event_at, content_hash = excluded.content_hash, observation_json = excluded.observation_json`).run(
                input.machineId,
                observation.sourceSessionId,
                observedAt,
                observation.lastEventAt,
                hash,
                json,
              );
              changed++;
            }
            db.exec('COMMIT');
            return { changed, unchanged, rejected };
          } catch (cause) {
            db.exec('ROLLBACK');
            throw cause;
          }
        },
        catch: (cause) => usageStoreError('importCodexWorkObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const queryCodexWorkObservations = (
    input: QueryCodexWorkObservationsInput,
  ): Effect.Effect<CodexWorkQueryResult, UsageStoreError> => {
    if (
      !validId(input.machineId) ||
      input.sourceSessionIds.length > MAX_CODEX_WORK_SESSION_FILTER ||
      !input.sourceSessionIds.every(validId)
    ) {
      return Effect.fail(
        usageStoreError(
          'queryCodexWorkObservations',
          input.dbPath,
          'Invalid or over-bound Codex work identity filter',
          'invalid-input',
        ),
      );
    }
    if (input.sourceSessionIds.length === 0) {
      return Effect.succeed({ observations: [], skipped: 0 });
    }
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const ids = [...new Set(input.sourceSessionIds)];
          const rows = db
            .query(`SELECT source_session_id, observed_at, observation_json FROM codex_work_observations
          WHERE machine_id = ? AND source_session_id IN (${ids.map(() => '?').join(',')}) ORDER BY source_session_id`)
            .all(input.machineId, ...ids);
          const observations: StoredCodexWorkObservation[] = [];
          let skipped = 0;
          for (const row of rows) {
            let observation: CodexWorkObservation | null = null;
            if (isRecord(row) && typeof row.observation_json === 'string') {
              try {
                observation = parseCodexWorkObservation(JSON.parse(row.observation_json));
              } catch {
                observation = null;
              }
            }
            const observedAt =
              isRecord(row) && typeof row.observed_at === 'string' ? normalizeIsoTimestamp(row.observed_at) : null;
            if (
              !isRecord(row) ||
              observation === null ||
              observedAt === null ||
              observation.sourceSessionId !== row.source_session_id ||
              observation.lastEventAt > observedAt
            ) {
              skipped++;
              continue;
            }
            observations.push({ ...observation, machineId: input.machineId, observedAt });
          }
          return { observations, skipped };
        },
        catch: (cause) => usageStoreReadError('queryCodexWorkObservations', input.dbPath, cause),
      }),
    );
  };
  return { importCodexWorkObservations, queryCodexWorkObservations };
};
