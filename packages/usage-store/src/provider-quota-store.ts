import { createHash } from 'node:crypto';
import {
  type ProviderQuotaObservation,
  parseProviderQuotaObservation,
  providerQuotaObservationFingerprintInput,
} from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import type {
  ImportProviderQuotaBatchInput,
  ProviderQuotaCheckpointUpdate,
  ProviderQuotaImportItem,
  ProviderQuotaImportResult,
  ProviderQuotaSourceState,
  QueryLatestLocalProviderQuotaObservationsInput,
  QueryLatestProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsResult,
  QueryProviderQuotaSourceStateInput,
  QueryProviderQuotaSourceStatesInput,
  RecordProviderQuotaSourceAttemptInput,
  RetainProviderQuotaObservationsInput,
  RetainProviderQuotaObservationsResult,
  StoredProviderQuotaObservation,
} from './index';

const MAX_PROVIDER_QUOTA_OBSERVATIONS = 10_000;
const MAX_PROVIDER_QUOTA_SOURCE_STATES = 1000;
export const MAX_PROVIDER_QUOTA_STREAMS = 10_000;
const MAX_PROVIDER_QUOTA_WINDOWS_PER_OBSERVATION = 256;
const DEFAULT_PROVIDER_QUOTA_FULL_RESOLUTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_PROVIDER_QUOTA_GRANULARITY_MS = 60 * 60 * 1000;
// Bounds the WAL growth of each retention transaction; every batch commits independently.
const PROVIDER_QUOTA_RETENTION_BATCH_SIZE = 20_000;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  finalize(): void;
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  clearStatements(): void;
  close(throwOnError?: boolean): void;
  exec(sql: string): unknown;
  readonly inTransaction: boolean;
  query(sql: string): SqliteStatement;
}

interface ProviderQuotaObservationRecord {
  account_scope: string | null;
  content_hash: string;
  first_observed_at: string;
  id: number;
  last_observed_at: string;
  machine_id: string;
  machine_label: string | null;
  plan: string | null;
  provider_generated_at: string | null;
  provider_key: string;
  provider_label: string;
  source_confidence: ProviderQuotaObservation['source']['confidence'];
  source_key: string;
  source_mode: ProviderQuotaObservation['source']['mode'];
  state: ProviderQuotaObservation['state'];
}

interface ProviderQuotaWindowRecord {
  blocked: number;
  label: string;
  limit_seconds: number | null;
  observation_id: number;
  provider_window_id: string;
  remaining_percent: number | null;
  reset_at: string | null;
  scope: ProviderQuotaObservation['windows'][number]['scope'];
  semantic_group: string | null;
  used_percent: number | null;
}

interface ProviderQuotaSourceStateRecord {
  cursor_json: string | null;
  cursor_key: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  machine_id: string;
  provider_key: string;
  source_key: string;
  updated_at: string;
}

interface ProviderQuotaStoreDependencies {
  readonly readUsageLocalMachineWithDatabase: (database: SqliteDatabase, dbPath: string) => UsageMachine;
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

export const createProviderQuotaStore = (dependencies: ProviderQuotaStoreDependencies) => {
  const {
    readUsageLocalMachineWithDatabase,
    usageStoreError,
    usageStoreReadError,
    withUsageStoreReader,
    withUsageStoreWriter,
  } = dependencies;

  const providerQuotaContentHash = (observation: ProviderQuotaObservation): string =>
    createHash('sha256').update(providerQuotaObservationFingerprintInput(observation)).digest('hex');

  const latestQuotaObservation = (
    db: SqliteDatabase,
    observation: ProviderQuotaObservation,
  ): ProviderQuotaObservationRecord | null =>
    db
      .query(`
        SELECT * FROM provider_quota_observations
        WHERE provider_key = ? AND machine_id = ? AND account_scope IS ? AND source_key = ?
        ORDER BY first_observed_at DESC, id DESC
        LIMIT 1
      `)
      .get(
        observation.providerKey,
        observation.machineId,
        observation.accountScope,
        observation.source.key,
      ) as ProviderQuotaObservationRecord | null;

  const insertQuotaObservation = (db: SqliteDatabase, item: ProviderQuotaImportItem, contentHash: string): number => {
    const observation = item.observation;
    const result = db
      .query(`
        INSERT INTO provider_quota_observations (
          provider_key, provider_label, account_scope, machine_id, machine_label,
          source_key, source_mode, source_confidence, source_event_key, state, plan,
          provider_generated_at, first_observed_at, last_observed_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .get(
        observation.providerKey,
        observation.providerLabel,
        observation.accountScope,
        observation.machineId,
        observation.machineLabel,
        observation.source.key,
        observation.source.mode,
        observation.source.confidence,
        item.sourceEventKey ?? null,
        observation.state,
        observation.plan,
        observation.providerGeneratedAt,
        observation.observedAt,
        observation.observedAt,
        contentHash,
      ) as { id: number };
    const insertWindow = db.query(`
      INSERT INTO provider_quota_windows (
        observation_id, provider_window_id, label, semantic_group, scope, limit_seconds,
        used_percent, remaining_percent, reset_at, blocked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const window of observation.windows) {
      insertWindow.run(
        result.id,
        window.id,
        window.label,
        window.group,
        window.scope,
        window.limitSeconds,
        window.usedPercent,
        window.remainingPercent,
        window.resetsAt,
        window.blocked ? 1 : 0,
      );
    }
    return result.id;
  };

  const quotaAccountScopeStorageKey = (accountScope: string | null): string =>
    accountScope === null ? 'n:' : `s:${accountScope}`;

  const quotaConfidenceRank = (confidence: ProviderQuotaObservation['source']['confidence']): number => {
    if (confidence === 'authoritative') {
      return 0;
    }
    return confidence === 'derived' ? 1 : 2;
  };

  const upsertQuotaReadProjection = (
    db: SqliteDatabase,
    observation: ProviderQuotaObservation,
    observationId: number,
  ): void => {
    db.query(`
      INSERT OR IGNORE INTO provider_quota_streams (
        provider_key, machine_id, account_scope_key, account_scope, source_key
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      observation.providerKey,
      observation.machineId,
      quotaAccountScopeStorageKey(observation.accountScope),
      observation.accountScope,
      observation.source.key,
    );
    db.query(`
      INSERT INTO provider_quota_latest_heads (
        provider_key, machine_id, account_scope_key, observation_id, confidence_rank, first_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_key, machine_id, account_scope_key) DO UPDATE SET
        observation_id = excluded.observation_id,
        confidence_rank = excluded.confidence_rank,
        first_observed_at = excluded.first_observed_at
      WHERE
        excluded.confidence_rank < provider_quota_latest_heads.confidence_rank OR
        (
          excluded.confidence_rank = provider_quota_latest_heads.confidence_rank AND
          (
            excluded.first_observed_at > provider_quota_latest_heads.first_observed_at OR
            (
              excluded.first_observed_at = provider_quota_latest_heads.first_observed_at AND
              excluded.observation_id > provider_quota_latest_heads.observation_id
            )
          )
        )
    `).run(
      observation.providerKey,
      observation.machineId,
      observation.accountScope ?? '',
      observationId,
      quotaConfidenceRank(observation.source.confidence),
      observation.observedAt,
    );
  };

  const insertQuotaSourceEvent = (
    db: SqliteDatabase,
    observation: ProviderQuotaObservation,
    sourceEventKey: string | undefined,
    observationId: number,
  ): void => {
    if (!sourceEventKey) {
      return;
    }
    db.query(`
      INSERT INTO provider_quota_source_events (
        provider_key, machine_id, source_key, source_event_key, observation_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(observation.providerKey, observation.machineId, observation.source.key, sourceEventKey, observationId);
  };

  const upsertQuotaCheckpoint = (
    db: SqliteDatabase,
    checkpoint: ProviderQuotaCheckpointUpdate,
    updatedAt: string,
  ): void => {
    db.query(`
      INSERT INTO provider_quota_source_state (
        provider_key, machine_id, source_key, cursor_key, cursor_json,
        last_attempt_at, last_success_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(provider_key, machine_id, source_key, cursor_key) DO UPDATE SET
        cursor_json = excluded.cursor_json,
        updated_at = excluded.updated_at
    `).run(
      checkpoint.providerKey,
      checkpoint.machineId,
      checkpoint.sourceKey,
      checkpoint.cursorKey,
      JSON.stringify(checkpoint.cursor),
      updatedAt,
    );
  };

  const assertProviderQuotaSourceStateBudget = (
    db: SqliteDatabase,
    input: Pick<QueryProviderQuotaSourceStateInput, 'machineId' | 'providerKey' | 'sourceKey'>,
  ): void => {
    const rows = db
      .query(`
        SELECT 1 FROM provider_quota_source_state
        WHERE provider_key = ? AND machine_id = ? AND source_key = ?
        LIMIT ?
      `)
      .all(input.providerKey, input.machineId, input.sourceKey, MAX_PROVIDER_QUOTA_SOURCE_STATES + 1);
    if (rows.length > MAX_PROVIDER_QUOTA_SOURCE_STATES) {
      throw new UsageStoreError({
        message: `Provider quota source state exceeds its ${MAX_PROVIDER_QUOTA_SOURCE_STATES}-cursor budget`,
        operation: 'writeProviderQuotaSourceState',
        reason: 'invalid-input',
      });
    }
  };

  const importProviderQuotaBatch = (
    input: ImportProviderQuotaBatchInput,
  ): Effect.Effect<ProviderQuotaImportResult, UsageStoreError> => {
    if (
      input.items.length > MAX_PROVIDER_QUOTA_OBSERVATIONS ||
      input.checkpointUpdates.length > MAX_PROVIDER_QUOTA_SOURCE_STATES ||
      input.items.some(({ observation }) => observation.windows.length > MAX_PROVIDER_QUOTA_WINDOWS_PER_OBSERVATION)
    ) {
      return Effect.fail(
        usageStoreError(
          'importProviderQuotaBatch',
          input.dbPath,
          'Provider quota batch exceeds its item, checkpoint, or window budget',
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result: ProviderQuotaImportResult = { coalesced: 0, inserted: 0, unchanged: 0 };
          const updatedAt = (input.importedAt ?? new Date()).toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const item of input.items) {
              const observation = parseProviderQuotaObservation(item.observation);
              if (!observation) {
                throw new Error('Provider quota observation failed strict validation');
              }
              if (item.sourceEventKey) {
                const existingEvent = db
                  .query(`
                    SELECT observation_id FROM provider_quota_source_events
                    WHERE provider_key = ? AND machine_id = ? AND source_key = ? AND source_event_key = ?
                  `)
                  .get(observation.providerKey, observation.machineId, observation.source.key, item.sourceEventKey);
                if (existingEvent) {
                  result.unchanged++;
                  continue;
                }
              }
              const contentHash = providerQuotaContentHash(observation);
              const latest = latestQuotaObservation(db, observation);
              const elapsedSinceFirst = latest
                ? Date.parse(observation.observedAt) - Date.parse(latest.first_observed_at)
                : Number.POSITIVE_INFINITY;
              if (latest?.content_hash === contentHash && elapsedSinceFirst < 30 * 60 * 1000) {
                db.query('UPDATE provider_quota_observations SET last_observed_at = ? WHERE id = ?').run(
                  observation.observedAt,
                  latest.id,
                );
                insertQuotaSourceEvent(db, observation, item.sourceEventKey, latest.id);
                result.coalesced++;
                continue;
              }
              const observationId = insertQuotaObservation(db, { ...item, observation }, contentHash);
              upsertQuotaReadProjection(db, observation, observationId);
              insertQuotaSourceEvent(db, observation, item.sourceEventKey, observationId);
              result.inserted++;
            }
            const streamBudgetRows = db
              .query('SELECT 1 FROM provider_quota_streams LIMIT ?')
              .all(MAX_PROVIDER_QUOTA_STREAMS + 1);
            if (streamBudgetRows.length > MAX_PROVIDER_QUOTA_STREAMS) {
              throw new Error(`Provider quota import exceeds its ${MAX_PROVIDER_QUOTA_STREAMS}-stream read budget`);
            }
            for (const checkpoint of input.checkpointUpdates) {
              upsertQuotaCheckpoint(db, checkpoint, updatedAt);
            }
            const affectedSources = new Map<string, ProviderQuotaCheckpointUpdate>();
            for (const checkpoint of input.checkpointUpdates) {
              affectedSources.set(
                JSON.stringify([checkpoint.providerKey, checkpoint.machineId, checkpoint.sourceKey]),
                checkpoint,
              );
            }
            for (const source of affectedSources.values()) {
              assertProviderQuotaSourceStateBudget(db, source);
            }
            if (result.inserted > 0 || result.coalesced > 0 || input.checkpointUpdates.length > 0) {
              db.query("UPDATE usage_store_metadata SET value = value + 1 WHERE key = 'generation'").run();
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return result;
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('importProviderQuotaBatch', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const quotaObservationFromRecords = (
    record: ProviderQuotaObservationRecord,
    windows: ProviderQuotaWindowRecord[],
  ): StoredProviderQuotaObservation | null => {
    const observation = parseProviderQuotaObservation({
      accountScope: record.account_scope,
      machineId: record.machine_id,
      machineLabel: record.machine_label,
      observedAt: record.first_observed_at,
      plan: record.plan,
      providerGeneratedAt: record.provider_generated_at,
      providerKey: record.provider_key,
      providerLabel: record.provider_label,
      source: {
        confidence: record.source_confidence,
        key: record.source_key,
        mode: record.source_mode,
      },
      state: record.state,
      windows: windows.map((window) => ({
        blocked: window.blocked === 1,
        group: window.semantic_group,
        id: window.provider_window_id,
        label: window.label,
        limitSeconds: window.limit_seconds,
        remainingPercent: window.remaining_percent,
        resetsAt: window.reset_at,
        scope: window.scope,
        usedPercent: window.used_percent,
      })),
    });
    return observation
      ? {
          firstObservedAt: record.first_observed_at,
          id: record.id,
          lastObservedAt: record.last_observed_at,
          observation,
        }
      : null;
  };

  const quotaQueryFilters = (
    input: Pick<QueryProviderQuotaObservationsInput, 'accountScope' | 'machineId' | 'providerKey'>,
    alias = '',
  ): { clauses: string[]; params: unknown[] } => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const column = (name: string): string => `${alias}${name}`;
    if (input.providerKey) {
      clauses.push(`${column('provider_key')} = ?`);
      params.push(input.providerKey);
    }
    if (input.machineId) {
      clauses.push(`${column('machine_id')} = ?`);
      params.push(input.machineId);
    }
    if (input.accountScope !== undefined) {
      clauses.push(`${column('account_scope')} IS ?`);
      params.push(input.accountScope);
    }
    return { clauses, params };
  };

  const quotaRangeIndex = (
    input: Pick<QueryProviderQuotaObservationsInput, 'accountScope' | 'machineId' | 'providerKey'>,
  ): string => {
    const hasAccount = input.accountScope !== undefined;
    if (input.providerKey && input.machineId && hasAccount) {
      return 'idx_provider_quota_range_provider_machine_account';
    }
    if (input.providerKey && input.machineId) {
      return 'idx_provider_quota_range_provider_machine';
    }
    if (input.providerKey && hasAccount) {
      return 'idx_provider_quota_range_provider_account';
    }
    if (input.machineId && hasAccount) {
      return 'idx_provider_quota_range_machine_account';
    }
    if (input.providerKey) {
      return 'idx_provider_quota_range_provider';
    }
    if (input.machineId) {
      return 'idx_provider_quota_range_machine';
    }
    return hasAccount ? 'idx_provider_quota_range_account' : 'idx_provider_quota_range_all';
  };

  const quotaLatestHeadIndex = (
    input: Pick<QueryLatestProviderQuotaObservationsInput, 'machineId' | 'providerKey'>,
  ): string => {
    if (input.providerKey && input.machineId) {
      return 'idx_provider_quota_heads_provider_machine';
    }
    if (input.providerKey) {
      return 'idx_provider_quota_heads_provider';
    }
    return input.machineId ? 'idx_provider_quota_heads_machine' : 'idx_provider_quota_heads_order';
  };

  const assertQuotaStreamBudget = (db: SqliteDatabase): void => {
    const rows = db.query('SELECT 1 FROM provider_quota_streams LIMIT ?').all(MAX_PROVIDER_QUOTA_STREAMS + 1);
    if (rows.length > MAX_PROVIDER_QUOTA_STREAMS) {
      throw new Error('Provider quota stream catalog exceeds its read budget');
    }
  };

  const readQuotaWindows = (
    db: SqliteDatabase,
    rows: readonly ProviderQuotaObservationRecord[],
  ): Map<number, ProviderQuotaWindowRecord[]> => {
    const windowsByObservation = new Map<number, ProviderQuotaWindowRecord[]>();
    if (rows.length === 0) {
      return windowsByObservation;
    }
    const placeholders = rows.map(() => '?').join(', ');
    const maximumWindows = rows.length * MAX_PROVIDER_QUOTA_WINDOWS_PER_OBSERVATION;
    const windowRows = db
      .query(`
        SELECT *
        FROM provider_quota_windows
        WHERE observation_id IN (${placeholders})
        ORDER BY observation_id, provider_window_id
        LIMIT ?
      `)
      .all(...rows.map((row) => row.id), maximumWindows + 1) as ProviderQuotaWindowRecord[];
    if (windowRows.length > maximumWindows) {
      throw new Error('Corrupt provider quota projection exceeds its window budget');
    }
    for (const window of windowRows) {
      const windows = windowsByObservation.get(window.observation_id) ?? [];
      windows.push(window);
      windowsByObservation.set(window.observation_id, windows);
    }
    return windowsByObservation;
  };

  const queryProviderQuotaObservations = (
    input: QueryProviderQuotaObservationsInput,
  ): Effect.Effect<QueryProviderQuotaObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const maximum = input.maximumObservations ?? MAX_PROVIDER_QUOTA_OBSERVATIONS;
          if (!(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_PROVIDER_QUOTA_OBSERVATIONS)) {
            throw usageStoreError(
              'queryProviderQuotaObservations',
              input.dbPath,
              `maximumObservations must be from 1 through ${MAX_PROVIDER_QUOTA_OBSERVATIONS}`,
              'invalid-input',
            );
          }
          assertQuotaStreamBudget(db);
          const filters = quotaQueryFilters(input);
          const filterSql = filters.clauses.length ? ` AND ${filters.clauses.join(' AND ')}` : '';
          const rangeIndex = quotaRangeIndex(input);
          const rangeSql = `
            SELECT * FROM provider_quota_observations INDEXED BY ${rangeIndex}
            WHERE first_observed_at >= ? AND first_observed_at <= ?${filterSql}
            ORDER BY first_observed_at ASC, id ASC
            LIMIT ?
          `;
          const rangeParams = [input.from, input.to, ...filters.params, maximum + 1];
          input.trace?.({ params: rangeParams, sql: rangeSql });
          const rangeRows = db.query(rangeSql).all(...rangeParams) as ProviderQuotaObservationRecord[];
          const streamFilters = quotaQueryFilters(input, 'streams.');
          const streamFilterSql = streamFilters.clauses.length ? `WHERE ${streamFilters.clauses.join(' AND ')}` : '';
          const hasExactAccountScope = input.accountScope !== undefined;
          const streamKeysSql = hasExactAccountScope
            ? `
                SELECT streams.provider_key, streams.machine_id, streams.account_scope, streams.source_key
                FROM provider_quota_streams AS streams
                ${streamFilterSql}
              `
            : `
                SELECT
                  streams.provider_key,
                  streams.machine_id,
                  COALESCE(streams.account_scope, '') AS account_scope_key,
                  streams.source_key
                FROM provider_quota_streams AS streams
                ${streamFilterSql}
                GROUP BY
                  streams.provider_key,
                  streams.machine_id,
                  COALESCE(streams.account_scope, ''),
                  streams.source_key
              `;
          const anchorIndex = hasExactAccountScope
            ? 'idx_provider_quota_anchor_exact'
            : 'idx_provider_quota_anchor_normalized';
          const anchorScopePredicate = hasExactAccountScope
            ? 'candidate.account_scope IS stream_keys.account_scope'
            : "COALESCE(candidate.account_scope, '') = stream_keys.account_scope_key";
          const anchorSql = `
            WITH stream_keys AS MATERIALIZED (${streamKeysSql})
            SELECT observations.*
            FROM stream_keys
            INNER JOIN provider_quota_observations AS observations
              ON observations.id = (
                SELECT candidate.id
                FROM provider_quota_observations AS candidate INDEXED BY ${anchorIndex}
                WHERE
                  candidate.provider_key = stream_keys.provider_key AND
                  candidate.machine_id = stream_keys.machine_id AND
                  ${anchorScopePredicate} AND
                  candidate.source_key = stream_keys.source_key AND
                  candidate.first_observed_at < ?
                ORDER BY candidate.first_observed_at DESC, candidate.id DESC
                LIMIT 1
              )
            ORDER BY observations.first_observed_at ASC, observations.id ASC
            LIMIT ?
          `;
          const anchorParams = [...streamFilters.params, input.from, maximum];
          input.trace?.({ params: anchorParams, sql: anchorSql });
          const beforeRows = db.query(anchorSql).all(...anchorParams) as ProviderQuotaObservationRecord[];
          const rows = [...beforeRows, ...rangeRows]
            .sort((left, right) => left.first_observed_at.localeCompare(right.first_observed_at) || left.id - right.id)
            .slice(0, maximum);
          if (rows.length === 0) {
            return { observations: [], skipped: 0, truncated: rangeRows.length > maximum };
          }
          const windowsByObservation = readQuotaWindows(db, rows);
          const observations: StoredProviderQuotaObservation[] = [];
          let skipped = 0;
          for (const row of rows) {
            const parsed = quotaObservationFromRecords(row, windowsByObservation.get(row.id) ?? []);
            if (parsed) {
              observations.push(parsed);
            } else {
              skipped++;
            }
          }
          return { observations, skipped, truncated: rangeRows.length > maximum };
        },
        catch: (cause) => usageStoreReadError('queryProviderQuotaObservations', input.dbPath, cause),
      }),
    );

  const queryProviderQuotaSourceState = (
    input: QueryProviderQuotaSourceStateInput,
  ): Effect.Effect<ProviderQuotaSourceState | null, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const row = db
            .query(`
              SELECT * FROM provider_quota_source_state
              WHERE provider_key = ? AND machine_id = ? AND source_key = ? AND cursor_key = ?
            `)
            .get(
              input.providerKey,
              input.machineId,
              input.sourceKey,
              input.cursorKey,
            ) as ProviderQuotaSourceStateRecord | null;
          if (!row) {
            return null;
          }
          return {
            cursor: row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as unknown),
            cursorKey: row.cursor_key,
            lastAttemptAt: row.last_attempt_at,
            lastSuccessAt: row.last_success_at,
            machineId: row.machine_id,
            providerKey: row.provider_key,
            sourceKey: row.source_key,
            updatedAt: row.updated_at,
          };
        },
        catch: (cause) => usageStoreReadError('queryProviderQuotaSourceState', input.dbPath, cause),
      }),
    );

  const queryProviderQuotaSourceStates = (
    input: QueryProviderQuotaSourceStatesInput,
  ): Effect.Effect<ProviderQuotaSourceState[], UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const maximumStates = input.maximumStates ?? MAX_PROVIDER_QUOTA_SOURCE_STATES;
          if (
            !(
              Number.isSafeInteger(maximumStates) &&
              maximumStates > 0 &&
              maximumStates <= MAX_PROVIDER_QUOTA_SOURCE_STATES
            )
          ) {
            throw usageStoreError(
              'queryProviderQuotaSourceStates',
              input.dbPath,
              `maximumStates must be from 1 through ${MAX_PROVIDER_QUOTA_SOURCE_STATES}`,
              'invalid-input',
            );
          }
          const rows = db
            .query(`
              SELECT * FROM provider_quota_source_state
              WHERE provider_key = ? AND machine_id = ? AND source_key = ?
              ORDER BY cursor_key
              LIMIT ?
            `)
            .all(
              input.providerKey,
              input.machineId,
              input.sourceKey,
              maximumStates + 1,
            ) as ProviderQuotaSourceStateRecord[];
          if (rows.length > maximumStates) {
            throw new Error('Corrupt provider quota source state exceeds its read budget');
          }
          return rows.map((row) => ({
            cursor: row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as unknown),
            cursorKey: row.cursor_key,
            lastAttemptAt: row.last_attempt_at,
            lastSuccessAt: row.last_success_at,
            machineId: row.machine_id,
            providerKey: row.provider_key,
            sourceKey: row.source_key,
            updatedAt: row.updated_at,
          }));
        },
        catch: (cause) => usageStoreReadError('queryProviderQuotaSourceStates', input.dbPath, cause),
      }),
    );

  const queryLatestProviderQuotaObservationsWithDatabase = (
    db: SqliteDatabase,
    input: QueryLatestProviderQuotaObservationsInput,
    operation: string,
  ): QueryProviderQuotaObservationsResult => {
    const maximum = input.maximumObservations ?? MAX_PROVIDER_QUOTA_OBSERVATIONS;
    if (!(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_PROVIDER_QUOTA_OBSERVATIONS)) {
      throw usageStoreError(
        operation,
        input.dbPath,
        `maximumObservations must be from 1 through ${MAX_PROVIDER_QUOTA_OBSERVATIONS}`,
        'invalid-input',
      );
    }
    const filters = quotaQueryFilters(input, 'heads.');
    const filterSql = filters.clauses.length ? `WHERE ${filters.clauses.join(' AND ')}` : '';
    const headIndex = quotaLatestHeadIndex(input);
    const latestSql = `
            WITH selected AS MATERIALIZED (
              SELECT
                heads.provider_key,
                heads.machine_id,
                heads.account_scope_key,
                heads.observation_id,
                heads.confidence_rank,
                heads.first_observed_at
              FROM provider_quota_latest_heads AS heads INDEXED BY ${headIndex}
              ${filterSql}
              ORDER BY heads.confidence_rank, heads.first_observed_at DESC, heads.observation_id DESC
              LIMIT ?
            )
            SELECT
              observations.*,
              selected.provider_key AS selected_provider_key,
              selected.machine_id AS selected_machine_id,
              selected.account_scope_key AS selected_account_scope_key,
              selected.observation_id AS selected_observation_id,
              selected.confidence_rank AS selected_confidence_rank,
              selected.first_observed_at AS selected_first_observed_at
            FROM selected
            LEFT JOIN provider_quota_observations AS observations ON observations.id = selected.observation_id
            ORDER BY
              selected.confidence_rank,
              selected.first_observed_at DESC,
              selected.observation_id DESC
          `;
    const latestParams = [...filters.params, maximum + 1];
    input.trace?.({ params: latestParams, sql: latestSql });
    const candidates = db.query(latestSql).all(...latestParams) as Array<
      ProviderQuotaObservationRecord & {
        selected_account_scope_key: string;
        selected_confidence_rank: number;
        selected_first_observed_at: string;
        selected_machine_id: string;
        selected_observation_id: number;
        selected_provider_key: string;
      }
    >;
    for (const candidate of candidates) {
      if (
        candidate.id !== candidate.selected_observation_id ||
        candidate.provider_key !== candidate.selected_provider_key ||
        candidate.machine_id !== candidate.selected_machine_id ||
        (candidate.account_scope ?? '') !== candidate.selected_account_scope_key ||
        quotaConfidenceRank(candidate.source_confidence) !== candidate.selected_confidence_rank ||
        candidate.first_observed_at !== candidate.selected_first_observed_at
      ) {
        throw new Error('Provider quota latest-head projection is corrupt');
      }
    }
    const truncated = candidates.length > maximum;
    const rows = candidates.slice(0, maximum);
    if (rows.length === 0) {
      return { observations: [], skipped: 0, truncated };
    }
    const byObservation = readQuotaWindows(db, rows);
    const observations: StoredProviderQuotaObservation[] = [];
    let skipped = 0;
    for (const row of rows) {
      const parsed = quotaObservationFromRecords(row, byObservation.get(row.id) ?? []);
      if (parsed) {
        observations.push(parsed);
      } else {
        skipped++;
      }
    }
    return { observations, skipped, truncated };
  };

  const queryLatestProviderQuotaObservations = (
    input: QueryLatestProviderQuotaObservationsInput,
  ): Effect.Effect<QueryProviderQuotaObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => queryLatestProviderQuotaObservationsWithDatabase(db, input, 'queryLatestProviderQuotaObservations'),
        catch: (cause) => usageStoreReadError('queryLatestProviderQuotaObservations', input.dbPath, cause),
      }),
    );

  const queryLatestLocalProviderQuotaObservations = (
    input: QueryLatestLocalProviderQuotaObservationsInput,
  ): Effect.Effect<QueryProviderQuotaObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          db.exec('BEGIN');
          try {
            const machine = readUsageLocalMachineWithDatabase(db, input.dbPath);
            const result = queryLatestProviderQuotaObservationsWithDatabase(
              db,
              { ...input, machineId: machine.id },
              'queryLatestLocalProviderQuotaObservations',
            );
            db.exec('COMMIT');
            return result;
          } catch (cause) {
            db.exec('ROLLBACK');
            throw cause;
          }
        },
        catch: (cause) => usageStoreReadError('queryLatestLocalProviderQuotaObservations', input.dbPath, cause),
      }),
    );

  const recordProviderQuotaSourceAttempt = (
    input: RecordProviderQuotaSourceAttemptInput,
  ): Effect.Effect<void, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const attemptedAt = (input.attemptedAt ?? new Date()).toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            db.query(`
              INSERT INTO provider_quota_source_state (
                provider_key, machine_id, source_key, cursor_key, cursor_json,
                last_attempt_at, last_success_at, updated_at
              ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
              ON CONFLICT(provider_key, machine_id, source_key, cursor_key) DO UPDATE SET
                last_attempt_at = excluded.last_attempt_at,
                last_success_at = CASE WHEN ? THEN excluded.last_success_at ELSE provider_quota_source_state.last_success_at END,
                updated_at = excluded.updated_at
            `).run(
              input.providerKey,
              input.machineId,
              input.sourceKey,
              input.cursorKey,
              attemptedAt,
              input.succeeded ? attemptedAt : null,
              attemptedAt,
              input.succeeded ? 1 : 0,
            );
            assertProviderQuotaSourceStateBudget(db, input);
            db.exec('COMMIT');
          } catch (cause) {
            db.exec('ROLLBACK');
            throw cause;
          }
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('recordProviderQuotaSourceAttempt', input.dbPath, cause, 'storage-failure'),
      }),
    );

  // Deleted rows only move pages to the freelist; the file itself never shrinks. A guarded
  // VACUUM reclaims the space after a large prune without paying a full rewrite on every run.
  const VACUUM_MINIMUM_FREELIST_BYTES = 100 * 1024 * 1024;
  const VACUUM_MINIMUM_FREELIST_RATIO = 0.2;
  const reclaimFreelistSpace = (db: SqliteDatabase): void => {
    const pageSize = (db.query('PRAGMA page_size').get() as { page_size: number }).page_size;
    const pageCount = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
    const freelistCount = (db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
    const freelistBytes = freelistCount * pageSize;
    if (pageCount === 0 || freelistBytes < VACUUM_MINIMUM_FREELIST_BYTES) {
      return;
    }
    if (freelistCount / pageCount < VACUUM_MINIMUM_FREELIST_RATIO) {
      return;
    }
    db.clearStatements();
    db.exec('VACUUM');
  };

  const retainProviderQuotaObservations = (
    input: RetainProviderQuotaObservationsInput,
  ): Effect.Effect<RetainProviderQuotaObservationsResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const now = input.now ?? Date.now();
          const fullResolutionMs = input.fullResolutionMs ?? DEFAULT_PROVIDER_QUOTA_FULL_RESOLUTION_MS;
          const granularityMs = input.granularityMs ?? DEFAULT_PROVIDER_QUOTA_GRANULARITY_MS;
          if (
            !(
              Number.isSafeInteger(now) &&
              now >= 0 &&
              Number.isSafeInteger(fullResolutionMs) &&
              fullResolutionMs > 0 &&
              Number.isSafeInteger(granularityMs) &&
              granularityMs > 0
            )
          ) {
            throw usageStoreError(
              'retainProviderQuotaObservations',
              input.dbPath,
              'Provider quota retention options are invalid',
              'invalid-input',
            );
          }
          const cutoff = new Date(now - fullResolutionMs).toISOString();
          const granularitySeconds = Math.max(1, Math.floor(granularityMs / 1000));
          // Beyond the full-resolution window, keep the earliest observation per stream and
          // time bucket, plus anything the latest-heads projection still points at. Windows
          // and source events follow through ON DELETE CASCADE. Each DELETE statement is its
          // own transaction, so a bounded batch size caps WAL growth on the first large prune.
          const deleteBatch = db.query(`
            DELETE FROM provider_quota_observations
            WHERE id IN (
              SELECT id FROM provider_quota_observations
              WHERE first_observed_at < ?
                AND id NOT IN (SELECT observation_id FROM provider_quota_latest_heads)
                AND id NOT IN (
                  SELECT MIN(id) FROM provider_quota_observations
                  WHERE first_observed_at < ?
                  GROUP BY
                    provider_key,
                    machine_id,
                    COALESCE(account_scope, ''),
                    source_key,
                    CAST(strftime('%s', first_observed_at) AS INTEGER) / ?
                )
              LIMIT ?
            )
          `);
          const countChanges = db.query('SELECT changes() AS changed');
          let deleted = 0;
          for (;;) {
            deleteBatch.run(cutoff, cutoff, granularitySeconds, PROVIDER_QUOTA_RETENTION_BATCH_SIZE);
            const { changed } = countChanges.get() as { changed: number };
            deleted += changed;
            if (changed < PROVIDER_QUOTA_RETENTION_BATCH_SIZE) {
              break;
            }
          }
          if (deleted > 0) {
            reclaimFreelistSpace(db);
          }
          return { deleted };
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('retainProviderQuotaObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );

  return {
    importProviderQuotaBatch,
    queryProviderQuotaObservations,
    queryProviderQuotaSourceState,
    queryProviderQuotaSourceStates,
    queryLatestProviderQuotaObservations,
    queryLatestLocalProviderQuotaObservations,
    recordProviderQuotaSourceAttempt,
    retainProviderQuotaObservations,
  };
};
