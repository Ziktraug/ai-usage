import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  MAX_SKILL_OBSERVATION_BATCH,
  MAX_SKILL_OBSERVATION_NAME_LENGTH,
  parseSkillObservation,
  SKILL_OBSERVATION_EXPOSURE_RETENTION_MS,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
} from '@ai-usage/report-core/skill-observation';
import {
  isSkillObservationTier,
  SKILL_OBSERVATION_INVOCATION_TIERS,
  SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS,
  SKILL_OBSERVATION_PRODUCER_MAX_AGE_MS,
  type SkillObservationRefusalCounts,
  skillObservabilityFor,
  skillObservationTierSupportsInvocation,
} from '@ai-usage/report-core/skill-observation-evidence';
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
const MAX_EXPECTED_SKILL_OBSERVATION_PRODUCERS = 64;
/**
 * The tiers that record a skill actually being used, as opposed to being listed
 * in a catalogue. They are read first and to their own bound, because they are
 * the scarce evidence: `exposed` is emitted per catalogue entry per session and
 * will always win a race for a shared budget.
 */
const INVOCATION_TIER_SQL = `tier IN (${SKILL_OBSERVATION_INVOCATION_TIERS.map(() => '?').join(', ')})`;
const EXPOSURE_TIER_SQL = "tier = 'exposed'";
// Bounds WAL growth of each retention transaction; every batch commits independently.
const SKILL_OBSERVATION_RETENTION_BATCH_SIZE = 20_000;

const producerProofValidUntilFrom = (minimumProducerCollectedAt: string | undefined): string | null => {
  if (minimumProducerCollectedAt === undefined) {
    return null;
  }
  const validUntil = new Date(Date.parse(minimumProducerCollectedAt) + SKILL_OBSERVATION_PRODUCER_MAX_AGE_MS);
  return Number.isFinite(validUntil.getTime()) ? validUntil.toISOString() : null;
};

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
  collected_at: string;
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
   * collectors re-scan on every sweep. A repeated observation counts as
   * unchanged without issuing a write or refreshing `last_observed_at`.
   */
  const importSkillObservations = (
    input: ImportSkillObservationsInput,
  ): Effect.Effect<SkillObservationImportResult, UsageStoreError> => {
    const minimumExposureObservedAt =
      input.minimumExposureObservedAt === undefined
        ? undefined
        : normalizeIsoTimestamp(input.minimumExposureObservedAt);
    if (
      input.observations.length > MAX_SKILL_OBSERVATION_BATCH ||
      !validCollection(input.collection) ||
      (input.minimumExposureObservedAt !== undefined && minimumExposureObservedAt === null)
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
          let exposureRejectedAtStore = 0;
          let invocationRejectedAtStore = 0;
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
                const candidateTier = isRecord(candidate) ? candidate.tier : undefined;
                if (isSkillObservationTier(candidateTier) && !skillObservationTierSupportsInvocation(candidateTier)) {
                  exposureRejectedAtStore++;
                } else {
                  // A known invocation tier, or a candidate whose tier cannot be recovered, may
                  // have been invocation evidence. Unknown loss stays conservative.
                  invocationRejectedAtStore++;
                }
                continue;
              }
              if (
                typeof minimumExposureObservedAt === 'string' &&
                observation.tier === 'exposed' &&
                observation.observedAt < minimumExposureObservedAt
              ) {
                continue;
              }
              const stored = existing.get(
                input.machineId,
                observation.harnessKey,
                observation.sessionId,
                observation.tier,
                observation.observationKey,
              ) as StoredContentRecord | null;
              if (stored !== null && sameStoredContent(stored, observation)) {
                result.unchanged++;
                continue;
              }
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
                exposure: {
                  rejected: input.collection.completeness.exposure.rejected + exposureRejectedAtStore,
                  truncated: input.collection.completeness.exposure.truncated,
                },
                invocation: {
                  rejected: input.collection.completeness.invocation.rejected + invocationRejectedAtStore,
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
          const expectedProducerHarnessKeys = input.expectedProducerHarnessKeys?.map((harnessKey) => harnessKey.trim());
          const expectedProducerHarnessKeySet =
            expectedProducerHarnessKeys === undefined ? undefined : new Set(expectedProducerHarnessKeys);
          const incompleteProducerHarnessKeys = input.incompleteProducerHarnessKeys?.map((harnessKey) =>
            harnessKey.trim(),
          );
          const incompleteProducerHarnessKeySet =
            incompleteProducerHarnessKeys === undefined ? undefined : new Set(incompleteProducerHarnessKeys);
          const minimumProducerCollectedAt =
            input.minimumProducerCollectedAt === undefined
              ? undefined
              : normalizeIsoTimestamp(input.minimumProducerCollectedAt);
          const producerProofValidUntil = producerProofValidUntilFrom(minimumProducerCollectedAt ?? undefined);
          const expectedProducerRosterValid =
            expectedProducerHarnessKeys === undefined ||
            (expectedProducerHarnessKeys.length <= MAX_EXPECTED_SKILL_OBSERVATION_PRODUCERS &&
              expectedProducerHarnessKeySet?.size === expectedProducerHarnessKeys.length &&
              expectedProducerHarnessKeys.every(
                (harnessKey) =>
                  harnessKey.length > 0 &&
                  harnessKey.length <= MAX_SKILL_OBSERVATION_NAME_LENGTH &&
                  skillObservabilityFor(harnessKey) === 'observable',
              ) &&
              (input.harnessKey === undefined ||
                skillObservabilityFor(input.harnessKey) !== 'observable' ||
                expectedProducerHarnessKeySet.has(input.harnessKey)) &&
              (expectedProducerHarnessKeys.length === 0 || input.machineId !== undefined));
          const incompleteProducerRosterValid =
            incompleteProducerHarnessKeys === undefined ||
            (expectedProducerHarnessKeySet !== undefined &&
              incompleteProducerHarnessKeys.length <= MAX_EXPECTED_SKILL_OBSERVATION_PRODUCERS &&
              incompleteProducerHarnessKeySet?.size === incompleteProducerHarnessKeys.length &&
              incompleteProducerHarnessKeys.every(
                (harnessKey) =>
                  harnessKey.length > 0 &&
                  harnessKey.length <= MAX_SKILL_OBSERVATION_NAME_LENGTH &&
                  expectedProducerHarnessKeySet.has(harnessKey),
              ));
          if (
            !(
              Number.isSafeInteger(maximum) &&
              maximum > 0 &&
              maximum <= MAX_SKILL_OBSERVATION_READ &&
              expectedProducerRosterValid &&
              incompleteProducerRosterValid &&
              (input.minimumProducerCollectedAt === undefined ||
                (minimumProducerCollectedAt !== null && producerProofValidUntil !== null))
            )
          ) {
            throw usageStoreError(
              'querySkillObservations',
              input.dbPath,
              'Skill observation query bounds, producer freshness, or producer roster are invalid',
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
                  const invocation = readTierGroup(INVOCATION_TIER_SQL, SKILL_OBSERVATION_INVOCATION_TIERS, maximum);
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
                    invocationTruncated: single.truncated && skillObservationTierSupportsInvocation(input.tier),
                    rows: single.rows,
                    truncated: single.truncated,
                  };
                })();
          const observations: StoredSkillObservation[] = [];
          let skippedExposure = 0;
          let skippedInvocation = 0;
          let skippedUnknown = 0;
          for (const row of read.rows) {
            const stored = storedObservationFromRecord(row);
            if (stored) {
              observations.push(stored);
            } else if (!isSkillObservationTier(row.tier)) {
              skippedUnknown++;
            } else if (skillObservationTierSupportsInvocation(row.tier)) {
              skippedInvocation++;
            } else {
              skippedExposure++;
            }
          }
          const refusedRows: SkillObservationRefusalCounts = {
            exposure: skippedExposure,
            invocation: skippedInvocation,
            unknown: skippedUnknown,
          };
          const relevantExpectedHarnessKeys =
            expectedProducerHarnessKeySet === undefined
              ? undefined
              : new Set(
                  [...expectedProducerHarnessKeySet].filter(
                    (harnessKey) =>
                      skillObservabilityFor(harnessKey) === 'observable' &&
                      (input.harnessKey === undefined || harnessKey === input.harnessKey),
                  ),
                );
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
          if (relevantExpectedHarnessKeys !== undefined && relevantExpectedHarnessKeys.size > 0) {
            stateClauses.push(`harness_key IN (${[...relevantExpectedHarnessKeys].map(() => '?').join(', ')})`);
            stateParams.push(...relevantExpectedHarnessKeys);
          }
          const stateLimit = relevantExpectedHarnessKeys?.size ?? MAX_EXPECTED_SKILL_OBSERVATION_PRODUCERS;
          const stateSql = `
            SELECT machine_id, harness_key, collected_at,
              invocation_truncated, invocation_rejected, exposure_truncated, exposure_rejected
            FROM skill_observation_collection_state
            ${stateClauses.length > 0 ? `WHERE ${stateClauses.join(' AND ')}` : ''}
            ORDER BY machine_id, harness_key
            LIMIT ?
          `;
          const stateQueryParams = [...stateParams, stateLimit + 1];
          input.trace?.({ params: stateQueryParams, sql: stateSql });
          const stateRows =
            relevantExpectedHarnessKeys?.size === 0
              ? []
              : (db.query(stateSql).all(...stateQueryParams) as SkillObservationCollectionStateRecord[]);
          const stateReadTruncated = stateRows.length > stateLimit;
          const states = stateRows.slice(0, stateLimit);
          const relevantStates =
            relevantExpectedHarnessKeys === undefined
              ? states.filter((state) => skillObservabilityFor(state.harness_key) === 'observable')
              : states.filter((state) => relevantExpectedHarnessKeys.has(state.harness_key));
          const stateIsCurrent = (state: SkillObservationCollectionStateRecord): boolean => {
            if (typeof minimumProducerCollectedAt !== 'string') {
              return true;
            }
            const collectedAt = normalizeIsoTimestamp(state.collected_at);
            return collectedAt !== null && collectedAt >= minimumProducerCollectedAt;
          };
          const incompleteRelevantHarnessKeys = new Set(
            [...(incompleteProducerHarnessKeySet ?? [])].filter(
              (harnessKey) => relevantExpectedHarnessKeys?.has(harnessKey) ?? false,
            ),
          );
          const usableStatePairs = new Set(
            relevantStates
              .filter((state) => stateIsCurrent(state) && !incompleteRelevantHarnessKeys.has(state.harness_key))
              .map(collectionPairKey),
          );
          const observableCollectionRequested =
            input.harnessKey === undefined || skillObservabilityFor(input.harnessKey) === 'observable';
          // A direct/legacy observation import can omit the producer state. Use
          // the already-bounded rows rather than an unbounded second store scan:
          // a missing state beside observable evidence is unknown, not complete.
          //
          // The completely empty case is distinct and load-bearing. Before the
          // first historical sweep, there are neither observations nor producer
          // states, so rows alone cannot reveal the missing answer. An explicit
          // empty sweep persists a state row; it clears this condition only
          // while that state is current and the producer remains available. A
          // not-observable harness such as Cursor never enters it.
          const collectionStateMissing =
            relevantExpectedHarnessKeys === undefined
              ? observableCollectionRequested &&
                (stateReadTruncated ||
                  relevantStates.length === 0 ||
                  relevantStates.some((state) => !stateIsCurrent(state)) ||
                  read.rows.some(
                    (row) =>
                      skillObservabilityFor(row.harness_key) === 'observable' &&
                      !usableStatePairs.has(
                        collectionPairKey({ harness_key: row.harness_key, machine_id: row.machine_id }),
                      ),
                  ))
              : stateReadTruncated ||
                incompleteRelevantHarnessKeys.size > 0 ||
                [...relevantExpectedHarnessKeys].some(
                  (harnessKey) =>
                    !usableStatePairs.has(
                      collectionPairKey({ harness_key: harnessKey, machine_id: input.machineId ?? '' }),
                    ),
                );
          // Which harnesses the incompleteness actually belongs to, so a consumer rendering one
          // harness's own count is not hedged by a different harness's rejection. The global
          // booleans below are unchanged and stay the answer for any cross-harness claim.
          //
          // `collectionStateMissing` is a fact about the expected roster as a whole — this read
          // cannot say whose answer was the missing, stale, disabled, or bounded-away one — so it
          // marks every expected harness rather than pretending to attribute it to one.
          const scopedHarnessKeys =
            relevantExpectedHarnessKeys ??
            new Set(
              SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS.filter(
                (harnessKey) => input.harnessKey === undefined || harnessKey === input.harnessKey,
              ),
            );
          const incompleteHarnessKeysFor = (
            channelIsIncomplete: (state: SkillObservationCollectionStateRecord) => boolean,
          ): string[] => {
            const keys = new Set<string>(collectionStateMissing ? scopedHarnessKeys : []);
            for (const state of relevantStates) {
              if (channelIsIncomplete(state)) {
                keys.add(state.harness_key);
              }
            }
            return [...keys].sort();
          };
          const exposureIsIncomplete = (state: SkillObservationCollectionStateRecord): boolean =>
            state.exposure_truncated === 1 || state.exposure_rejected > 0;
          const invocationIsIncomplete = (state: SkillObservationCollectionStateRecord): boolean =>
            state.invocation_truncated === 1 || state.invocation_rejected > 0;
          return {
            collectionExposureIncomplete: collectionStateMissing || relevantStates.some(exposureIsIncomplete),
            collectionExposureIncompleteHarnessKeys: incompleteHarnessKeysFor(exposureIsIncomplete),
            collectionInvocationIncomplete: collectionStateMissing || relevantStates.some(invocationIsIncomplete),
            collectionInvocationIncompleteHarnessKeys: incompleteHarnessKeysFor(invocationIsIncomplete),
            invocationTruncated: read.invocationTruncated,
            observations,
            producerCompletenessMissing: collectionStateMissing,
            producerProofValidUntil,
            refusedRows,
            skipped: skippedExposure + skippedInvocation + skippedUnknown,
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
          const exposureRetentionMs = input.exposureRetentionMs ?? SKILL_OBSERVATION_EXPOSURE_RETENTION_MS;
          if (
            !(
              Number.isSafeInteger(now) &&
              now >= 0 &&
              Number.isSafeInteger(exposureRetentionMs) &&
              exposureRetentionMs > 0
            )
          ) {
            throw usageStoreError(
              'retainSkillObservations',
              input.dbPath,
              'Skill observation retention options are invalid',
              'invalid-input',
            );
          }
          // Catalogue exposure is abundant and weaker than invocation evidence,
          // so only that tier uses an age cutoff. Declared and inferred history
          // remains durable.
          const cutoff = new Date(now - exposureRetentionMs).toISOString();
          const deleteBatch = db.query(`
            DELETE FROM skill_observations
            WHERE id IN (
              SELECT id FROM skill_observations
              WHERE tier = 'exposed' AND observed_at < ?
              LIMIT ?
            )
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
