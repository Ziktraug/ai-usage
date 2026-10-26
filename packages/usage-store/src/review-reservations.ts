import { DELEGATION_LIVE_STATES } from '@ai-usage/report-core/delegation-vocabulary';
import { REVIEW_ATTEMPT_LIVE_STATES } from '@ai-usage/report-core/work-attempts';
import { executorDeclarationKey, parseExecutorDeclarations } from '@ai-usage/report-core/work-executors';

/**
 * The reservations both review families hold, read and judged by one rule. A review attempt (the
 * Work view's legacy launch, `review_attempts`) and a delegation job (`delegation_jobs`) reserve
 * the same two things: one target (a checkout at one frozen revision) and one slot of one quota
 * pool (`declared:<machine, harness, account>`). Each family's insert transaction calls
 * `checkReviewReservations` against the holders of BOTH tables, under its own `BEGIN IMMEDIATE`,
 * so a legacy attempt and a delegation can neither review one target twice nor exceed one pool's
 * limit together. The delegation qualification reads the same holders for its advisory answer.
 *
 * What a row reserves is read from what it recorded, never guessed:
 *
 * - a row that persisted its frozen revision reserves exactly that (checkout, base, head);
 * - a legacy row without one, whose recorded scope names its SHAs, reserves what that scope names;
 * - a legacy row with neither reserves its whole checkout; one without a checkout reserves every
 *   target of the machine. Both cases are said in the refusal: the uncertainty is the fact.
 * - a legacy row's pool comes from its stored declaration; a missing or unparseable declaration
 *   makes the pool unknown, and the row counts against every pool of its harness on the machine.
 *
 * Reserving rows: live states, or `lost` and not yet released. Nothing here releases anything:
 * `lost` rows go only through their families' evidence paths (process absent, outcome recorded
 * late, operator declaration), never by age.
 */
export type ReviewReservationFamily = 'delegation' | 'review-attempt';

export type ReviewReservationScope =
  | {
      readonly baseSha: string;
      readonly checkoutPath: string;
      readonly headSha: string;
      readonly kind: 'revision';
      /** `frozen`: persisted at request time; `recorded-scope`: read from the scope the launch recorded. */
      readonly provenance: 'frozen' | 'recorded-scope';
    }
  | { readonly checkoutPath: string; readonly kind: 'checkout' }
  | { readonly kind: 'machine' };

export interface ReviewReservationHolder {
  readonly action: string;
  readonly family: ReviewReservationFamily;
  /** The executor harness the row names; `null` when it names none (then it counts against every harness). */
  readonly harness: string | null;
  readonly id: string;
  /** `declared:<key>`; `null` when the pool cannot be read from the row (counts against every pool of its harness). */
  readonly poolId: string | null;
  readonly scope: ReviewReservationScope;
  readonly state: string;
}

export interface ReviewReservationPool {
  readonly harness: string;
  readonly poolId: string;
}

export interface ReviewReservationTarget {
  readonly action: string;
  readonly baseSha: string;
  readonly checkoutPath: string;
  readonly headSha: string;
}

export type ReviewReservationCheck =
  | { readonly kind: 'free' }
  | { readonly holder: ReviewReservationHolder; readonly kind: 'target-reserved'; readonly message: string }
  | {
      readonly count: number;
      readonly holders: readonly ReviewReservationHolder[];
      readonly kind: 'pool-busy';
      readonly message: string;
    };

export interface CheckReviewReservationsInput {
  readonly holders: readonly ReviewReservationHolder[];
  readonly maxConcurrent: number;
  readonly pool: ReviewReservationPool;
  readonly target: ReviewReservationTarget;
}

interface SqliteDatabase {
  query: (sql: string) => { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown };
}

interface ReviewAttemptReservationRecord {
  attempt_id: string;
  base_sha: string | null;
  checkout_path: string | null;
  declaration_json: string | null;
  executor_harness: string;
  head_sha: string | null;
  scope_json: string | null;
  state: string;
}

interface DelegationReservationRecord {
  action: string;
  base_sha: string | null;
  checkout_path: string | null;
  executor_harness: string | null;
  head_sha: string | null;
  job_id: string;
  pool_id: string | null;
  state: string;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const sqlList = (values: readonly string[]): string => `(${values.map((value) => `'${value}'`).join(', ')})`;
const LEGACY_RESERVING_SQL = `(state IN ${sqlList(REVIEW_ATTEMPT_LIVE_STATES)} OR (state = 'lost' AND released_at IS NULL))`;
const DELEGATION_RESERVING_SQL = `(state IN ${sqlList(DELEGATION_LIVE_STATES)} OR (state = 'lost' AND released_at IS NULL))`;
/** The only action either family executes; a legacy row carries it by its column check. */
const REVIEW_ACTION = 'read-only-review';

const hasTable = (db: SqliteDatabase, table: string): boolean =>
  db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== null;

const columnsOf = (db: SqliteDatabase, table: string): ReadonlySet<string> =>
  new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as { name?: unknown }[])
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string'),
  );

const isObjectId = (value: unknown): value is string => typeof value === 'string' && OBJECT_ID.test(value);

const parseJson = (text: string | null): unknown => {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** The SHAs a legacy row's recorded scope names, when it recorded one that names two object ids. */
const recordedScopeShas = (scopeJson: string | null): { readonly baseSha: string; readonly headSha: string } | null => {
  const value = parseJson(scopeJson);
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { baseSha, headSha } = value as { baseSha?: unknown; headSha?: unknown };
  return isObjectId(baseSha) && isObjectId(headSha) ? { baseSha, headSha } : null;
};

/** The pool a legacy row belongs to, from its stored declaration; `null` when that cannot be read. */
const legacyPoolOf = (declarationJson: string | null, machineId: string): string | null => {
  const value = parseJson(declarationJson);
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const parsed = parseExecutorDeclarations({ executors: [value] }, { defaultMachineId: machineId });
  const declaration = parsed.declarations[0];
  return declaration === undefined ? null : `declared:${executorDeclarationKey(declaration)}`;
};

const scopeOf = (
  checkoutPath: string | null,
  baseSha: string | null,
  headSha: string | null,
  scopeJson: string | null,
): ReviewReservationScope => {
  if (checkoutPath === null) {
    return { kind: 'machine' };
  }
  if (isObjectId(baseSha) && isObjectId(headSha)) {
    return { baseSha, checkoutPath, headSha, kind: 'revision', provenance: 'frozen' };
  }
  const recorded = recordedScopeShas(scopeJson);
  if (recorded !== null) {
    return { ...recorded, checkoutPath, kind: 'revision', provenance: 'recorded-scope' };
  }
  return { checkoutPath, kind: 'checkout' };
};

/**
 * Every reserving row of both families on one machine, as the shared rule reads them. Widen-only:
 * a `review_attempts` table from before the frozen-revision columns reads them as absent, and an
 * absent `delegation_jobs` table holds no job. Callers run it inside their own transaction when
 * the answer must be atomic with their insert.
 */
export const readReviewReservationHolders = (db: SqliteDatabase, machineId: string): ReviewReservationHolder[] => {
  const holders: ReviewReservationHolder[] = [];
  const legacyColumns = columnsOf(db, 'review_attempts');
  const frozen = legacyColumns.has('base_sha') && legacyColumns.has('head_sha');
  const legacyRows = db
    .query(`
      SELECT attempt_id, state, executor_harness, declaration_json, checkout_path, scope_json,
        ${frozen ? 'base_sha, head_sha' : 'NULL AS base_sha, NULL AS head_sha'}
      FROM review_attempts
      WHERE machine_id = ? AND ${LEGACY_RESERVING_SQL}
      ORDER BY requested_at, attempt_id
    `)
    .all(machineId) as ReviewAttemptReservationRecord[];
  for (const row of legacyRows) {
    holders.push({
      action: REVIEW_ACTION,
      family: 'review-attempt',
      harness: row.executor_harness,
      id: row.attempt_id,
      poolId: legacyPoolOf(row.declaration_json, machineId),
      scope: scopeOf(row.checkout_path, row.base_sha, row.head_sha, row.scope_json),
      state: row.state,
    });
  }
  if (hasTable(db, 'delegation_jobs')) {
    const jobRows = db
      .query(`
        SELECT job_id, state, action, executor_harness, pool_id, checkout_path, base_sha, head_sha
        FROM delegation_jobs
        WHERE machine_id = ? AND ${DELEGATION_RESERVING_SQL}
        ORDER BY requested_at, job_id
      `)
      .all(machineId) as DelegationReservationRecord[];
    for (const row of jobRows) {
      holders.push({
        action: row.action,
        family: 'delegation',
        harness: row.executor_harness,
        id: row.job_id,
        poolId: row.pool_id,
        scope: scopeOf(row.checkout_path, row.base_sha, row.head_sha, null),
        state: row.state,
      });
    }
  }
  return holders;
};

const holderLabel = (holder: ReviewReservationHolder): string =>
  `${holder.family === 'delegation' ? 'delegation job' : 'review attempt'} ${holder.id} (${holder.state})`;

/** Whether the holder's reservation covers the target; an uncertain scope covers what it cannot exclude. */
const reservesTarget = (holder: ReviewReservationHolder, target: ReviewReservationTarget): boolean => {
  if (holder.action !== target.action) {
    return false;
  }
  switch (holder.scope.kind) {
    case 'machine':
      return true;
    case 'checkout':
      return holder.scope.checkoutPath === target.checkoutPath;
    default:
      return (
        holder.scope.checkoutPath === target.checkoutPath &&
        holder.scope.baseSha === target.baseSha &&
        holder.scope.headSha === target.headSha
      );
  }
};

/** Why the holder reserves the target, with the uncertainty named when the row recorded less than a revision. */
export const describeReviewReservation = (holder: ReviewReservationHolder): string => {
  const label = holderLabel(holder);
  switch (holder.scope.kind) {
    case 'machine':
      return `${label} reserves every target of this machine: it recorded neither a checkout nor a reviewed revision (a row from before frozen revisions), so every review on this machine counts as reserved until it is released with evidence`;
    case 'checkout':
      return `${label} reserves the whole checkout ${holder.scope.checkoutPath}: it recorded no reviewed revision (a row from before frozen revisions), so every revision of that checkout counts as reserved until it is released with evidence`;
    default:
      return holder.scope.provenance === 'frozen'
        ? `${label} already reserves this review (same action, checkout and frozen revision)`
        : `${label} already reserves this review: the scope it recorded at launch names the same checkout and revision (its frozen revision was not persisted at request time)`;
  }
};

/** The holder, if any, whose reservation covers the target; the earliest request first. */
export const reviewTargetReservationHolder = (
  holders: readonly ReviewReservationHolder[],
  target: ReviewReservationTarget,
): ReviewReservationHolder | null => holders.find((holder) => reservesTarget(holder, target)) ?? null;

/** Whether the holder occupies a slot of the pool; an unknown pool occupies every pool of its harness. */
const occupiesPool = (holder: ReviewReservationHolder, pool: ReviewReservationPool): boolean => {
  if (holder.poolId !== null) {
    return holder.poolId === pool.poolId;
  }
  return holder.harness === null || holder.harness === pool.harness;
};

const describePoolHolder = (holder: ReviewReservationHolder, pool: ReviewReservationPool): string =>
  holder.poolId === null
    ? `${holderLabel(holder)} [pool unknown: its declaration is missing or does not parse, so it counts against every ${holder.harness ?? 'executor'} pool on this machine]`
    : `${holderLabel(holder)}${holder.poolId === pool.poolId ? '' : ` [pool ${holder.poolId}]`}`;

/**
 * Reserving rows per pool, for the pools the policy knows: a holder with a known pool counts under
 * it (known to the policy or not); a holder with an unknown pool counts under every known pool of
 * its harness. The delegation qualification shows these beside each route.
 */
export const countReviewReservationsByPool = (
  holders: readonly ReviewReservationHolder[],
  pools: readonly ReviewReservationPool[],
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const pool of pools) {
    counts.set(pool.poolId, holders.filter((holder) => occupiesPool(holder, pool)).length);
  }
  for (const holder of holders) {
    if (holder.poolId !== null && !counts.has(holder.poolId)) {
      counts.set(holder.poolId, holders.filter((other) => other.poolId === holder.poolId).length);
    }
  }
  return counts;
};

/**
 * The shared admission rule at insert time: the target must be free of both families, then the
 * pool must have a slot under `maxConcurrent`, legacy attempts and delegation jobs counted together.
 */
export const checkReviewReservations = (input: CheckReviewReservationsInput): ReviewReservationCheck => {
  const holder = reviewTargetReservationHolder(input.holders, input.target);
  if (holder !== null) {
    return {
      holder,
      kind: 'target-reserved',
      message: `${describeReviewReservation(holder)}; follow it instead of starting another.`,
    };
  }
  const occupants = input.holders.filter((candidate) => occupiesPool(candidate, input.pool));
  if (occupants.length >= input.maxConcurrent) {
    return {
      count: occupants.length,
      holders: occupants,
      kind: 'pool-busy',
      message: `Pool ${input.pool.poolId} runs ${occupants.length} reserving job(s) or attempt(s): ${occupants
        .slice(0, 8)
        .map((occupant) => describePoolHolder(occupant, input.pool))
        .join(', ')}; the limit is ${input.maxConcurrent}.`,
    };
  }
  return { kind: 'free' };
};
