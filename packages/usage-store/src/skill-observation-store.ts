import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  MAX_SKILL_OBSERVATION_BATCH,
  MAX_SKILL_OBSERVATION_NAME_LENGTH,
  parseSkillObservation,
  SKILL_OBSERVATION_RETENTION_MS,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
  skillObservabilityFor,
} from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import type {
  ImportSkillObservationsInput,
  QuerySkillObservationsInput,
  QuerySkillObservationsResult,
  RetainSkillObservationsInput,
  RetainSkillObservationsResult,
  SkillObservationImportResult,
  StoredSkillObservation,
} from './index';

/**
 * Durable storage for the skill-observation fact family (ADR 0022), modelled on
 * `provider-quota-store.ts`: its own tables, its own collector, and a read path
 * that does not go through the report bootstrap.
 *
 * Two properties are load-bearing and easy to erode:
 *
 * - **Rows are re-validated on read.** `parseSkillObservation` runs on the way
 *   out as well as in, so any tightening of that parser retroactively hides
 *   history already on disk. Rows that fail are counted in `skipped`, never
 *   silently discarded.
 * - **The tier never collapses.** Reads group by tier and harness; nothing here
 *   sums across them.
 * - **The tiers do not compete for the read budget.** They are not produced at
 *   comparable rates: a Codex session writes one `exposed` row per catalogue
 *   skill, so exposure outnumbers actual invocations by orders of magnitude. A
 *   single pooled `ORDER BY observed_at DESC LIMIT n` therefore spends the whole
 *   budget on catalogue injections and starves the evidence the feature exists
 *   to show. See `querySkillObservations`.
 */

const MAX_SKILL_OBSERVATION_READ = 50_000;
/**
 * The tiers that record a skill actually being used, as opposed to being listed
 * in a catalogue. They are read first and to their own bound, because they are
 * the scarce evidence: `exposed` is emitted per catalogue entry per session and
 * will always win a race for a shared budget.
 */
const INVOCATION_TIERS: ReadonlySet<string> = new Set(['declared', 'inferred']);
const INVOCATION_TIER_SQL = "tier IN ('declared', 'inferred')";
const EXPOSURE_TIER_SQL = "tier = 'exposed'";
// Bounds WAL growth of each retention transaction; every batch commits independently.
const SKILL_OBSERVATION_RETENTION_BATCH_SIZE = 20_000;

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

interface SkillObservationRecord {
  args_present: number | null;
  first_observed_at: string;
  harness_key: string;
  id: number;
  last_observed_at: string;
  machine_id: string;
  observation_key: string;
  observed_at: string;
  project_path: string | null;
  resolved_path: string | null;
  session_id: string;
  skill_name: string;
  success: number | null;
  tier: string;
}

interface SkillObservationCollectionStateRecord {
  exposure_rejected: number;
  exposure_truncated: number;
  harness_key: string;
  invocation_rejected: number;
  invocation_truncated: number;
  machine_id: string;
}

interface SkillObservationStoreDependencies {
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

const booleanColumn = (value: boolean | null): number | null => {
  if (value === null) {
    return null;
  }
  return value ? 1 : 0;
};

const booleanFromColumn = (value: number | null): boolean | null => {
  if (value === null) {
    return null;
  }
  return value === 1;
};

/** The read's documented order, applied across tier-group pages rather than by SQL alone. */
const byRecencyDescending = (left: SkillObservationRecord, right: SkillObservationRecord): number => {
  if (left.observed_at !== right.observed_at) {
    return left.observed_at < right.observed_at ? 1 : -1;
  }
  return right.id - left.id;
};

interface StoredContentRecord {
  args_present: number | null;
  observed_at: string;
  project_path: string | null;
  resolved_path: string | null;
  skill_name: string;
  success: number | null;
}

/**
 * Whether a re-imported observation says the same thing as the stored one.
 *
 * **Identity rows are mutable, deliberately.** The identity — machine, harness,
 * session, tier, and the harness's own call id — names one real event that
 * happened once. What can change is this product's *reading* of it: a collector
 * fix that resolves a path it previously could not, or that stops mis-parsing
 * one. Making identity rows immutable would freeze the worse reading forever
 * and leave no way to repair history short of deleting it, so a changed
 * extraction overwrites.
 *
 * Overwriting is only honest if it is reported, which is what this comparison
 * is for: an unchanged repeat stays `unchanged` and leaves the served report
 * alone, while a genuine correction counts as `updated` and advances the
 * generation like any other durable change.
 *
 * `first_observed_at` and `last_observed_at` are excluded on purpose — they
 * record when this store saw the row, not what the row says.
 */
const sameStoredContent = (stored: StoredContentRecord, observation: SkillObservation): boolean =>
  stored.skill_name === observation.skillName &&
  stored.observed_at === observation.observedAt &&
  stored.project_path === observation.projectPath &&
  stored.resolved_path === observation.resolvedPath &&
  booleanFromColumn(stored.args_present) === observation.argsPresent &&
  booleanFromColumn(stored.success) === observation.success;

const validCompletenessPart = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const rejected = value.rejected;
  return (
    typeof rejected === 'number' &&
    Number.isSafeInteger(rejected) &&
    rejected >= 0 &&
    rejected <= Number.MAX_SAFE_INTEGER - MAX_SKILL_OBSERVATION_BATCH &&
    typeof value.truncated === 'boolean'
  );
};

const validCollection = (input: unknown): boolean =>
  input === undefined ||
  (isRecord(input) &&
    typeof input.harnessKey === 'string' &&
    isRecord(input.completeness) &&
    input.harnessKey.trim().length > 0 &&
    input.harnessKey.trim().length <= MAX_SKILL_OBSERVATION_NAME_LENGTH &&
    validCompletenessPart(input.completeness.invocation) &&
    validCompletenessPart(input.completeness.exposure));

const sameCollectionCompleteness = (
  stored: SkillObservationCollectionStateRecord | null,
  completeness: SkillObservationCollectionCompleteness,
): boolean =>
  stored !== null &&
  stored.invocation_truncated === Number(completeness.invocation.truncated) &&
  stored.invocation_rejected === completeness.invocation.rejected &&
  stored.exposure_truncated === Number(completeness.exposure.truncated) &&
  stored.exposure_rejected === completeness.exposure.rejected;

const collectionPairKey = (pair: Pick<SkillObservationCollectionStateRecord, 'harness_key' | 'machine_id'>): string =>
  JSON.stringify([pair.machine_id, pair.harness_key]);

export const createSkillObservationStore = (dependencies: SkillObservationStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  /**
   * Re-import of an unchanged transcript is the normal case, not an error: the
   * collectors re-scan on every sweep. A repeated observation refreshes
   * `last_observed_at` and counts as unchanged.
   */
  const importSkillObservations = (
    input: ImportSkillObservationsInput,
  ): Effect.Effect<SkillObservationImportResult, UsageStoreError> => {
    const minimumObservedAt =
      input.minimumObservedAt === undefined ? undefined : normalizeIsoTimestamp(input.minimumObservedAt);
    if (
      input.observations.length > MAX_SKILL_OBSERVATION_BATCH ||
      !validCollection(input.collection) ||
      (input.minimumObservedAt !== undefined && minimumObservedAt === null)
    ) {
      return Effect.fail(
        usageStoreError(
          'importSkillObservations',
          input.dbPath,
          'Skill observation batch metadata is invalid or exceeds its budget',
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result: SkillObservationImportResult = {
            inserted: 0,
            rejected: 0,
            stateChanged: false,
            unchanged: 0,
            updated: 0,
          };
          const importedAt = (input.importedAt ?? new Date()).toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            // The identity is checked before the write rather than inferred
            // from a RETURNING expression: two imports inside one batch share
            // an `importedAt`, which would make a first/last timestamp
            // comparison call a repeat an insert.
            //
            // The row's semantic fields come back with it so a re-import can be
            // classified honestly. See `sameStoredContent` for why an identity
            // row is mutable at all.
            const existing = db.query(`
              SELECT skill_name, observed_at, project_path, resolved_path, args_present, success
              FROM skill_observations
              WHERE machine_id = ? AND harness_key = ? AND session_id = ? AND tier = ? AND observation_key = ?
            `);
            const insert = db.query(`
              INSERT INTO skill_observations (
                harness_key, skill_name, tier, machine_id, session_id, observation_key,
                observed_at, project_path, resolved_path, args_present, success,
                first_observed_at, last_observed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(machine_id, harness_key, session_id, tier, observation_key) DO UPDATE SET
                last_observed_at = excluded.last_observed_at,
                skill_name = excluded.skill_name,
                observed_at = excluded.observed_at,
                project_path = excluded.project_path,
                resolved_path = excluded.resolved_path,
                args_present = excluded.args_present,
                success = excluded.success
            `);
            for (const candidate of input.observations) {
              const observation = parseSkillObservation(candidate);
              if (!observation) {
                // A malformed observation is counted, never dropped in silence:
                // the collector that produced it is the thing to fix.
                result.rejected++;
                continue;
              }
              if (typeof minimumObservedAt === 'string' && observation.observedAt < minimumObservedAt) {
                continue;
              }
              const stored = existing.get(
                input.machineId,
                observation.harnessKey,
                observation.sessionId,
                observation.tier,
                observation.observationKey,
              ) as StoredContentRecord | null;
              insert.run(
                observation.harnessKey,
                observation.skillName,
                observation.tier,
                input.machineId,
                observation.sessionId,
                observation.observationKey,
                observation.observedAt,
                observation.projectPath,
                observation.resolvedPath,
                booleanColumn(observation.argsPresent),
                booleanColumn(observation.success),
                importedAt,
                importedAt,
              );
              if (stored === null) {
                result.inserted++;
              } else if (sameStoredContent(stored, observation)) {
                result.unchanged++;
              } else {
                // The upsert above just rewrote six semantic fields. Reporting
                // that as `unchanged` would tell the engine nothing happened
                // while the durable row moved underneath it.
                result.updated++;
              }
            }
            if (input.collection !== undefined) {
              const harnessKey = input.collection.harnessKey.trim();
              const completeness: SkillObservationCollectionCompleteness = {
                exposure: { ...input.collection.completeness.exposure },
                // A store-edge refusal has an unknown tier, so it must weaken the invocation claim.
                invocation: {
                  rejected: input.collection.completeness.invocation.rejected + result.rejected,
                  truncated: input.collection.completeness.invocation.truncated,
                },
              };
              const stored = db
                .query(`
                  SELECT invocation_truncated, invocation_rejected, exposure_truncated, exposure_rejected
                  FROM skill_observation_collection_state
                  WHERE machine_id = ? AND harness_key = ?
                `)
                .get(input.machineId, harnessKey) as SkillObservationCollectionStateRecord | null;
              result.stateChanged = !sameCollectionCompleteness(stored, completeness);
              db.query(`
                INSERT INTO skill_observation_collection_state (
                  machine_id, harness_key,
                  invocation_truncated, invocation_rejected,
                  exposure_truncated, exposure_rejected,
                  collected_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(machine_id, harness_key) DO UPDATE SET
                  invocation_truncated = excluded.invocation_truncated,
                  invocation_rejected = excluded.invocation_rejected,
                  exposure_truncated = excluded.exposure_truncated,
                  exposure_rejected = excluded.exposure_rejected,
                  collected_at = excluded.collected_at
              `).run(
                input.machineId,
                harnessKey,
                Number(completeness.invocation.truncated),
                completeness.invocation.rejected,
                Number(completeness.exposure.truncated),
                completeness.exposure.rejected,
                importedAt,
              );
            }
            // Only a real change advances the generation. The collectors
            // re-import the same observations on every sweep, so counting an
            // unchanged repeat here would invalidate the served report once per
            // cycle for no reason. Matches the provider-quota precedent. An
            // update is a real change and does advance it.
            if (result.inserted > 0 || result.updated > 0 || result.stateChanged) {
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
            : usageStoreError('importSkillObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const storedObservationFromRecord = (record: SkillObservationRecord): StoredSkillObservation | null => {
    const observation = parseSkillObservation({
      argsPresent: booleanFromColumn(record.args_present),
      harnessKey: record.harness_key,
      observationKey: record.observation_key,
      observedAt: record.observed_at,
      projectPath: record.project_path,
      resolvedPath: record.resolved_path,
      sessionId: record.session_id,
      skillName: record.skill_name,
      success: booleanFromColumn(record.success),
      tier: record.tier,
    });
    return observation
      ? {
          firstObservedAt: record.first_observed_at,
          id: record.id,
          lastObservedAt: record.last_observed_at,
          machineId: record.machine_id,
          observation,
        }
      : null;
  };

  const querySkillObservations = (
    input: QuerySkillObservationsInput,
  ): Effect.Effect<QuerySkillObservationsResult, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const maximum = input.maximumObservations ?? MAX_SKILL_OBSERVATION_READ;
          if (!(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_SKILL_OBSERVATION_READ)) {
            throw usageStoreError(
              'querySkillObservations',
              input.dbPath,
              `maximumObservations must be from 1 through ${MAX_SKILL_OBSERVATION_READ}`,
              'invalid-input',
            );
          }
          const clauses: string[] = [];
          const params: unknown[] = [];
          if (input.skillName !== undefined) {
            clauses.push('skill_name = ?');
            params.push(input.skillName);
          }
          if (input.harnessKey !== undefined) {
            clauses.push('harness_key = ?');
            params.push(input.harnessKey);
          }
          if (input.machineId !== undefined) {
            clauses.push('machine_id = ?');
            params.push(input.machineId);
          }
          if (input.from !== undefined) {
            clauses.push('observed_at >= ?');
            params.push(input.from);
          }
          if (input.to !== undefined) {
            clauses.push('observed_at <= ?');
            params.push(input.to);
          }
          /**
           * One recency-ordered page of one tier group.
           *
           * Asks for `limit + 1` and reports the overflow, so a page that stops
           * exactly at its budget is distinguishable from a complete one. A
           * `limit` of zero is therefore a pure existence probe: it returns no
           * rows and still answers whether any were left behind.
           */
          const readTierGroup = (
            tierSql: string,
            tierParams: readonly unknown[],
            limit: number,
          ): { readonly rows: SkillObservationRecord[]; readonly truncated: boolean } => {
            const sql = `
            SELECT * FROM skill_observations
            WHERE ${[...clauses, tierSql].join(' AND ')}
            ORDER BY observed_at DESC, id DESC
            LIMIT ?
          `;
            const queryParams = [...params, ...tierParams, limit + 1];
            input.trace?.({ params: queryParams, sql });
            const rows = db.query(sql).all(...queryParams) as SkillObservationRecord[];
            return { rows: rows.slice(0, limit), truncated: rows.length > limit };
          };

          /**
           * Two reads, not one, and the order between them is the whole point.
           *
           * `exposed` is written once per catalogue entry per session, so on a
           * real store it outnumbers actual invocations by roughly 66:1. Under a
           * single pooled `LIMIT`, the most recent rows are almost entirely
           * catalogue injections and months of real invocation history fall
           * outside the window — which the surface then renders as
           * "offered but never invoked", a statement the data contradicts.
           *
           * So the invocation tiers are read first, against the full budget, and
           * exposure fills whatever is left. Both bounds are reported separately,
           * because "we could not show every catalogue injection" and "we could
           * not show every invocation" are different facts and only the second
           * one makes an absence verdict unsafe.
           */
          const read =
            input.tier === undefined
              ? (() => {
                  const invocation = readTierGroup(INVOCATION_TIER_SQL, [], maximum);
                  const exposure = readTierGroup(EXPOSURE_TIER_SQL, [], maximum - invocation.rows.length);
                  return {
                    invocationTruncated: invocation.truncated,
                    // Recency order is restored across the two pages, so this read's documented
                    // ordering is unchanged. Only *which* rows it selects has changed.
                    rows: [...invocation.rows, ...exposure.rows].sort(byRecencyDescending),
                    truncated: invocation.truncated || exposure.truncated,
                  };
                })()
              : (() => {
                  // A caller that named one tier gets exactly that tier; there is no second group to
                  // budget against. The invocation bound is then simply whether that read was cut
                  // short, and only when the named tier is itself invocation evidence.
                  const single = readTierGroup('tier = ?', [input.tier], maximum);
                  return {
                    invocationTruncated: single.truncated && INVOCATION_TIERS.has(input.tier),
                    rows: single.rows,
                    truncated: single.truncated,
                  };
                })();
          const observations: StoredSkillObservation[] = [];
          let skipped = 0;
          for (const row of read.rows) {
            const stored = storedObservationFromRecord(row);
            if (stored) {
              observations.push(stored);
            } else {
              skipped++;
            }
          }
          const stateClauses: string[] = [];
          const stateParams: unknown[] = [];
          if (input.harnessKey !== undefined) {
            stateClauses.push('harness_key = ?');
            stateParams.push(input.harnessKey);
          }
          if (input.machineId !== undefined) {
            stateClauses.push('machine_id = ?');
            stateParams.push(input.machineId);
          }
          const states = db
            .query(`
              SELECT machine_id, harness_key,
                invocation_truncated, invocation_rejected, exposure_truncated, exposure_rejected
              FROM skill_observation_collection_state
              ${stateClauses.length > 0 ? `WHERE ${stateClauses.join(' AND ')}` : ''}
            `)
            .all(...stateParams) as SkillObservationCollectionStateRecord[];
          const statePairs = new Set(states.map(collectionPairKey));
          const observableCollectionRequested =
            input.harnessKey === undefined || skillObservabilityFor(input.harnessKey) === 'observable';
          // A direct/legacy observation import can omit the producer state. Use
          // the already-bounded rows rather than an unbounded second store scan:
          // a missing state beside observable evidence is unknown, not complete.
          //
          // The completely empty case is distinct and load-bearing. Before the
          // first historical sweep, there are neither observations nor producer
          // states, so rows alone cannot reveal the missing answer. An explicit
          // complete empty sweep persists a state row and clears this condition;
          // a not-observable harness such as Cursor never enters it.
          const collectionStateMissing =
            observableCollectionRequested &&
            (states.length === 0 ||
              read.rows.some(
                (row) =>
                  skillObservabilityFor(row.harness_key) === 'observable' &&
                  !statePairs.has(collectionPairKey({ harness_key: row.harness_key, machine_id: row.machine_id })),
              ));
          return {
            collectionExposureIncomplete: states.some(
              (state) => state.exposure_truncated === 1 || state.exposure_rejected > 0,
            ),
            collectionInvocationIncomplete:
              collectionStateMissing ||
              states.some((state) => state.invocation_truncated === 1 || state.invocation_rejected > 0),
            invocationTruncated: read.invocationTruncated,
            observations,
            producerCompletenessMissing: collectionStateMissing,
            skipped,
            truncated: read.truncated,
          };
        },
        catch: (cause) => usageStoreReadError('querySkillObservations', input.dbPath, cause),
      }),
    );

  const retainSkillObservations = (
    input: RetainSkillObservationsInput,
  ): Effect.Effect<RetainSkillObservationsResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const now = input.now ?? Date.now();
          const retentionMs = input.retentionMs ?? SKILL_OBSERVATION_RETENTION_MS;
          if (!(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(retentionMs) && retentionMs > 0)) {
            throw usageStoreError(
              'retainSkillObservations',
              input.dbPath,
              'Skill observation retention options are invalid',
              'invalid-input',
            );
          }
          // Observations are small and few - tens to hundreds - so retention is
          // a plain age cutoff rather than the quota family's downsampling.
          // Nothing here is aggregated away: an observation is kept whole or
          // dropped whole, so a surviving count never silently changes meaning.
          const cutoff = new Date(now - retentionMs).toISOString();
          const deleteBatch = db.query(`
            DELETE FROM skill_observations
            WHERE id IN (SELECT id FROM skill_observations WHERE observed_at < ? LIMIT ?)
          `);
          const countChanges = db.query('SELECT changes() AS changed');
          let deleted = 0;
          for (;;) {
            deleteBatch.run(cutoff, SKILL_OBSERVATION_RETENTION_BATCH_SIZE);
            const { changed } = countChanges.get() as { changed: number };
            deleted += changed;
            if (changed < SKILL_OBSERVATION_RETENTION_BATCH_SIZE) {
              break;
            }
          }
          return { deleted };
        },
        catch: (cause) =>
          cause instanceof UsageStoreError
            ? cause
            : usageStoreError('retainSkillObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );

  return { importSkillObservations, querySkillObservations, retainSkillObservations };
};
