import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type CheckoutStatusObservation,
  JIRA_ISSUE_KEY_PATTERN,
  type JiraIssueObservation,
  type PullRequestObservation,
  parseCheckoutStatusObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import type { UsageStoreError, UsageStoreErrorReason } from './errors';
import type {
  ImportCheckoutStatusObservationsInput,
  ImportJiraIssueObservationsInput,
  ImportPullRequestObservationsInput,
  LatestCheckoutStatusObservations,
  LatestJiraIssueObservations,
  LatestPullRequestObservations,
  QueryLatestCheckoutStatusObservationsInput,
  QueryLatestJiraIssueObservationsInput,
  QueryLatestPullRequestObservationsInput,
  QueryWorkFactRunStatesInput,
  RecordWorkFactRunInput,
  WorkFactImportResult,
  WorkFactRunState,
  WorkFactRunStates,
} from './index';

/**
 * Durable storage for the external and local fact family of the Work view (ADR 0051, ADR 0054):
 * dated GitHub pull request observations, dated checkout status observations, dated Jira issue
 * observations, and one run state row per producing source. Modelled on `skill-observation-store.ts`:
 *
 * - **Rows are re-validated on read** with the shared contract parsers; a row that no longer
 *   parses is counted in `skipped`, never silently dropped.
 * - **A failed observation never overwrites a successful one.** Every observation is its own
 *   row; the readers return, per pull request or checkout, both the latest observation and the
 *   latest *successful* one, so a failure stays visible beside the last known state.
 * - **Retention is per identity.** The newest `WORK_FACT_RETENTION_PER_KEY` rows are kept, plus
 *   the newest successful row when a failure streak would otherwise push it out.
 * - **Outside the served revision.** Nothing here touches the store generation, the publication
 *   or the replication outbox; these facts are local to the observing machine.
 */

export const WORK_FACT_SOURCE_IDS = ['checkouts.status', 'github.pull-requests', 'jira.issues'] as const;
export type WorkFactSourceId = (typeof WORK_FACT_SOURCE_IDS)[number];

export const WORK_FACT_RETENTION_PER_KEY = 5;
export const MAX_WORK_FACT_BATCH = 500;
export const MAX_WORK_FACT_QUERY_LIMIT = 500;
export const DEFAULT_WORK_FACT_QUERY_LIMIT = 200;

export const workFactSchemaSql = `
  CREATE TABLE IF NOT EXISTS pull_request_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    observed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    outcome_message TEXT,
    account_label TEXT,
    state TEXT,
    draft INTEGER CHECK (draft IN (0, 1)),
    review_decision TEXT,
    merged_at TEXT,
    updated_at TEXT,
    title TEXT,
    url TEXT,
    head_ref TEXT,
    base_ref TEXT,
    checks_rollup TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_request_observations_identity
    ON pull_request_observations(machine_id, host, repository, number, observed_at DESC);

  CREATE TABLE IF NOT EXISTS checkout_status_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    checkout_path TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    branch TEXT,
    head_sha TEXT,
    upstream TEXT,
    ahead INTEGER CHECK (ahead IS NULL OR ahead >= 0),
    behind INTEGER CHECK (behind IS NULL OR behind >= 0),
    staged_count INTEGER CHECK (staged_count IS NULL OR staged_count >= 0),
    modified_count INTEGER CHECK (modified_count IS NULL OR modified_count >= 0),
    untracked_count INTEGER CHECK (untracked_count IS NULL OR untracked_count >= 0),
    last_commit_at TEXT,
    dirty INTEGER CHECK (dirty IN (0, 1))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_status_observations_identity
    ON checkout_status_observations(machine_id, checkout_path, observed_at DESC);

  CREATE TABLE IF NOT EXISTS jira_issue_observations (
    id INTEGER PRIMARY KEY,
    machine_id TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    outcome_message TEXT,
    status TEXT,
    status_category TEXT,
    summary TEXT,
    updated_at TEXT,
    assignee_label TEXT,
    sprint TEXT,
    parent_key TEXT,
    comment_count INTEGER CHECK (comment_count IS NULL OR comment_count >= 0),
    comments_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_issue_observations_identity
    ON jira_issue_observations(machine_id, issue_key, observed_at DESC);

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

export const WORK_FACT_TABLES = [
  'pull_request_observations',
  'checkout_status_observations',
  'jira_issue_observations',
  'work_fact_run_state',
] as const;

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  finalize: () => void;
  get: (...params: unknown[]) => unknown;
  iterate: (...params: unknown[]) => IterableIterator<unknown>;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  clearStatements: () => void;
  close: (throwOnError?: boolean) => void;
  exec: (sql: string) => unknown;
  readonly inTransaction: boolean;
  query: (sql: string) => SqliteStatement;
}

interface WorkFactStoreDependencies {
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

interface PullRequestRecord {
  account_label: string | null;
  base_ref: string | null;
  checks_rollup: string | null;
  draft: number | null;
  head_ref: string | null;
  host: string;
  id: number;
  machine_id: string;
  merged_at: string | null;
  number: number;
  observed_at: string;
  outcome: string;
  outcome_message: string | null;
  rank_all: number;
  repository: string;
  review_decision: string | null;
  state: string | null;
  title: string | null;
  updated_at: string | null;
  url: string | null;
}

interface CheckoutStatusRecord {
  ahead: number | null;
  behind: number | null;
  branch: string | null;
  checkout_path: string;
  dirty: number | null;
  head_sha: string | null;
  id: number;
  last_commit_at: string | null;
  machine_id: string;
  modified_count: number | null;
  observed_at: string;
  outcome: string;
  rank_all: number;
  staged_count: number | null;
  untracked_count: number | null;
  upstream: string | null;
}

interface JiraIssueRecord {
  assignee_label: string | null;
  comment_count: number | null;
  comments_json: string;
  id: number;
  issue_key: string;
  machine_id: string;
  observed_at: string;
  outcome: string;
  outcome_message: string | null;
  parent_key: string | null;
  rank_all: number;
  sprint: string | null;
  status: string | null;
  status_category: string | null;
  summary: string | null;
  updated_at: string | null;
}

interface RunStateRecord {
  disabled: number;
  failed: number;
  machine_id: string;
  message: string | null;
  observed: number;
  ran_at: string;
  source_id: string;
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

const pullRequestValue = (record: PullRequestRecord): unknown => ({
  accountLabel: record.account_label,
  baseRef: record.base_ref,
  checksRollup: record.checks_rollup,
  draft: booleanFromColumn(record.draft),
  headRef: record.head_ref,
  host: record.host,
  machineId: record.machine_id,
  mergedAt: record.merged_at,
  number: record.number,
  observedAt: record.observed_at,
  outcome: record.outcome,
  outcomeMessage: record.outcome_message,
  repository: record.repository,
  reviewDecision: record.review_decision,
  state: record.state,
  title: record.title,
  updatedAt: record.updated_at,
  url: record.url,
});

const checkoutStatusValue = (record: CheckoutStatusRecord): unknown => ({
  ahead: record.ahead,
  behind: record.behind,
  branch: record.branch,
  checkoutPath: record.checkout_path,
  dirty: booleanFromColumn(record.dirty),
  headSha: record.head_sha,
  lastCommitAt: record.last_commit_at,
  machineId: record.machine_id,
  modifiedCount: record.modified_count,
  observedAt: record.observed_at,
  outcome: record.outcome,
  stagedCount: record.staged_count,
  untrackedCount: record.untracked_count,
  upstream: record.upstream,
});

/** The stored comments; a column that no longer parses is handed over as text, which is not a list and fails re-validation. */
const commentsFromColumn = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const jiraIssueValue = (record: JiraIssueRecord): unknown => ({
  assigneeLabel: record.assignee_label,
  commentCount: record.comment_count,
  comments: commentsFromColumn(record.comments_json),
  key: record.issue_key,
  machineId: record.machine_id,
  observedAt: record.observed_at,
  outcome: record.outcome,
  outcomeMessage: record.outcome_message,
  parentKey: record.parent_key,
  sprint: record.sprint,
  status: record.status,
  statusCategory: record.status_category,
  summary: record.summary,
  updatedAt: record.updated_at,
});

const isWorkFactSourceId = (value: unknown): value is WorkFactSourceId =>
  typeof value === 'string' && (WORK_FACT_SOURCE_IDS as readonly string[]).includes(value);

const validLimit = (limit: number | undefined): number | null => {
  if (limit === undefined) {
    return DEFAULT_WORK_FACT_QUERY_LIMIT;
  }
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_WORK_FACT_QUERY_LIMIT ? limit : null;
};

const validMachineId = (machineId: string | undefined): boolean =>
  machineId === undefined || (machineId.trim().length > 0 && machineId.length <= WORK_ATTENTION_BOUNDS.maxId);

const changes = (db: SqliteDatabase): number =>
  (db.query('SELECT changes() AS changed').get() as { changed: number }).changed;

/**
 * Groups the ranked rows of one read into `{ latest, latestObserved }` items. Rows arrive
 * ordered by key then rank, so the first row of a key is its latest observation and a second
 * row, when present, is its latest successful one.
 */
const groupLatest = <Record extends { rank_all: number }, Observation extends { outcome: string }>(
  records: readonly Record[],
  keyOf: (record: Record) => string,
  parse: (record: Record) => Observation | null,
  limit: number,
): {
  items: Array<{ latest: Observation; latestObserved: Observation | null }>;
  skipped: number;
  truncated: boolean;
} => {
  const items: Array<{ latest: Observation; latestObserved: Observation | null }> = [];
  const latestByKey = new Map<string, { latest: Observation; latestObserved: Observation | null }>();
  const keys: string[] = [];
  let skipped = 0;
  for (const record of records) {
    const key = keyOf(record);
    const parsed = parse(record);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    if (record.rank_all === 1) {
      const item = { latest: parsed, latestObserved: parsed.outcome === 'observed' ? parsed : null };
      latestByKey.set(key, item);
      keys.push(key);
      continue;
    }
    const item = latestByKey.get(key);
    if (item !== undefined && item.latestObserved === null) {
      item.latestObserved = parsed;
    }
  }
  const truncated = keys.length > limit;
  for (const key of keys.slice(0, limit)) {
    const item = latestByKey.get(key);
    if (item !== undefined) {
      items.push(item);
    }
  }
  return { items, skipped, truncated };
};

export const createWorkFactStore = (dependencies: WorkFactStoreDependencies) => {
  const { usageStoreError, usageStoreReadError, withUsageStoreReader, withUsageStoreWriter } = dependencies;

  const retainPullRequest = (
    db: SqliteDatabase,
    key: Pick<PullRequestObservation, 'host' | 'machineId' | 'number' | 'repository'>,
  ): number => {
    db.query(`
      DELETE FROM pull_request_observations
      WHERE machine_id = ? AND host = ? AND repository = ? AND number = ?
        AND id NOT IN (
          SELECT id FROM pull_request_observations
          WHERE machine_id = ? AND host = ? AND repository = ? AND number = ?
          ORDER BY observed_at DESC, id DESC
          LIMIT ${WORK_FACT_RETENTION_PER_KEY}
        )
        AND id NOT IN (
          SELECT id FROM pull_request_observations
          WHERE machine_id = ? AND host = ? AND repository = ? AND number = ? AND outcome = 'observed'
          ORDER BY observed_at DESC, id DESC
          LIMIT 1
        )
    `).run(
      key.machineId,
      key.host,
      key.repository,
      key.number,
      key.machineId,
      key.host,
      key.repository,
      key.number,
      key.machineId,
      key.host,
      key.repository,
      key.number,
    );
    return changes(db);
  };

  const retainCheckout = (
    db: SqliteDatabase,
    key: Pick<CheckoutStatusObservation, 'checkoutPath' | 'machineId'>,
  ): number => {
    db.query(`
      DELETE FROM checkout_status_observations
      WHERE machine_id = ? AND checkout_path = ?
        AND id NOT IN (
          SELECT id FROM checkout_status_observations
          WHERE machine_id = ? AND checkout_path = ?
          ORDER BY observed_at DESC, id DESC
          LIMIT ${WORK_FACT_RETENTION_PER_KEY}
        )
        AND id NOT IN (
          SELECT id FROM checkout_status_observations
          WHERE machine_id = ? AND checkout_path = ? AND outcome = 'observed'
          ORDER BY observed_at DESC, id DESC
          LIMIT 1
        )
    `).run(key.machineId, key.checkoutPath, key.machineId, key.checkoutPath, key.machineId, key.checkoutPath);
    return changes(db);
  };

  const retainJiraIssue = (db: SqliteDatabase, key: Pick<JiraIssueObservation, 'key' | 'machineId'>): number => {
    db.query(`
      DELETE FROM jira_issue_observations
      WHERE machine_id = ? AND issue_key = ?
        AND id NOT IN (
          SELECT id FROM jira_issue_observations
          WHERE machine_id = ? AND issue_key = ?
          ORDER BY observed_at DESC, id DESC
          LIMIT ${WORK_FACT_RETENTION_PER_KEY}
        )
        AND id NOT IN (
          SELECT id FROM jira_issue_observations
          WHERE machine_id = ? AND issue_key = ? AND outcome = 'observed'
          ORDER BY observed_at DESC, id DESC
          LIMIT 1
        )
    `).run(key.machineId, key.key, key.machineId, key.key, key.machineId, key.key);
    return changes(db);
  };

  const importPullRequestObservations = (
    input: ImportPullRequestObservationsInput,
  ): Effect.Effect<WorkFactImportResult, UsageStoreError> => {
    if (input.observations.length > MAX_WORK_FACT_BATCH) {
      return Effect.fail(
        usageStoreError(
          'importPullRequestObservations',
          input.dbPath,
          `Pull request observation batch exceeds ${MAX_WORK_FACT_BATCH} rows`,
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result = { inserted: 0, pruned: 0, rejected: 0, unchanged: 0 };
          const touched = new Map<
            string,
            Pick<PullRequestObservation, 'host' | 'machineId' | 'number' | 'repository'>
          >();
          db.exec('BEGIN IMMEDIATE');
          try {
            const insert = db.query(`
              INSERT OR IGNORE INTO pull_request_observations (
                machine_id, host, repository, number, observed_at, outcome, outcome_message, account_label,
                state, draft, review_decision, merged_at, updated_at, title, url, head_ref, base_ref, checks_rollup
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const candidate of input.observations) {
              const observation = parsePullRequestObservation(candidate);
              if (observation === null) {
                result.rejected += 1;
                continue;
              }
              insert.run(
                observation.machineId,
                observation.host,
                observation.repository,
                observation.number,
                observation.observedAt,
                observation.outcome,
                observation.outcomeMessage,
                observation.accountLabel,
                observation.state,
                booleanColumn(observation.draft),
                observation.reviewDecision,
                observation.mergedAt,
                observation.updatedAt,
                observation.title,
                observation.url,
                observation.headRef,
                observation.baseRef,
                observation.checksRollup,
              );
              if (changes(db) === 1) {
                result.inserted += 1;
              } else {
                result.unchanged += 1;
              }
              touched.set(
                JSON.stringify([observation.machineId, observation.host, observation.repository, observation.number]),
                observation,
              );
            }
            for (const key of touched.values()) {
              result.pruned += retainPullRequest(db, key);
            }
            db.exec('COMMIT');
          } catch (cause) {
            db.exec('ROLLBACK');
            throw cause;
          }
          return result;
        },
        catch: (cause) => usageStoreError('importPullRequestObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const importCheckoutStatusObservations = (
    input: ImportCheckoutStatusObservationsInput,
  ): Effect.Effect<WorkFactImportResult, UsageStoreError> => {
    if (input.observations.length > MAX_WORK_FACT_BATCH) {
      return Effect.fail(
        usageStoreError(
          'importCheckoutStatusObservations',
          input.dbPath,
          `Checkout status observation batch exceeds ${MAX_WORK_FACT_BATCH} rows`,
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result = { inserted: 0, pruned: 0, rejected: 0, unchanged: 0 };
          const touched = new Map<string, Pick<CheckoutStatusObservation, 'checkoutPath' | 'machineId'>>();
          db.exec('BEGIN IMMEDIATE');
          try {
            const insert = db.query(`
              INSERT OR IGNORE INTO checkout_status_observations (
                machine_id, checkout_path, observed_at, outcome, branch, head_sha, upstream, ahead, behind,
                staged_count, modified_count, untracked_count, last_commit_at, dirty
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const candidate of input.observations) {
              const observation = parseCheckoutStatusObservation(candidate);
              if (observation === null) {
                result.rejected += 1;
                continue;
              }
              insert.run(
                observation.machineId,
                observation.checkoutPath,
                observation.observedAt,
                observation.outcome,
                observation.branch,
                observation.headSha,
                observation.upstream,
                observation.ahead,
                observation.behind,
                observation.stagedCount,
                observation.modifiedCount,
                observation.untrackedCount,
                observation.lastCommitAt,
                booleanColumn(observation.dirty),
              );
              if (changes(db) === 1) {
                result.inserted += 1;
              } else {
                result.unchanged += 1;
              }
              touched.set(JSON.stringify([observation.machineId, observation.checkoutPath]), observation);
            }
            for (const key of touched.values()) {
              result.pruned += retainCheckout(db, key);
            }
            db.exec('COMMIT');
          } catch (cause) {
            db.exec('ROLLBACK');
            throw cause;
          }
          return result;
        },
        catch: (cause) => usageStoreError('importCheckoutStatusObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const importJiraIssueObservations = (
    input: ImportJiraIssueObservationsInput,
  ): Effect.Effect<WorkFactImportResult, UsageStoreError> => {
    if (input.observations.length > MAX_WORK_FACT_BATCH) {
      return Effect.fail(
        usageStoreError(
          'importJiraIssueObservations',
          input.dbPath,
          `Jira issue observation batch exceeds ${MAX_WORK_FACT_BATCH} rows`,
          'invalid-input',
        ),
      );
    }
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const result = { inserted: 0, pruned: 0, rejected: 0, unchanged: 0 };
          const touched = new Map<string, Pick<JiraIssueObservation, 'key' | 'machineId'>>();
          db.exec('BEGIN IMMEDIATE');
          try {
            const insert = db.query(`
              INSERT OR IGNORE INTO jira_issue_observations (
                machine_id, issue_key, observed_at, outcome, outcome_message, status, status_category, summary,
                updated_at, assignee_label, sprint, parent_key, comment_count, comments_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const candidate of input.observations) {
              const observation = parseJiraIssueObservation(candidate);
              if (observation === null) {
                result.rejected += 1;
                continue;
              }
              insert.run(
                observation.machineId,
                observation.key,
                observation.observedAt,
                observation.outcome,
                observation.outcomeMessage,
                observation.status,
                observation.statusCategory,
                observation.summary,
                observation.updatedAt,
                observation.assigneeLabel,
                observation.sprint,
                observation.parentKey,
                observation.commentCount,
                JSON.stringify(observation.comments),
              );
              if (changes(db) === 1) {
                result.inserted += 1;
              } else {
                result.unchanged += 1;
              }
              touched.set(JSON.stringify([observation.machineId, observation.key]), observation);
            }
            for (const key of touched.values()) {
              result.pruned += retainJiraIssue(db, key);
            }
            db.exec('COMMIT');
          } catch (cause) {
            db.exec('ROLLBACK');
            throw cause;
          }
          return result;
        },
        catch: (cause) => usageStoreError('importJiraIssueObservations', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const recordWorkFactRun = (input: RecordWorkFactRunInput): Effect.Effect<{ changed: boolean }, UsageStoreError> => {
    const ranAt = normalizeIsoTimestamp(input.ranAt);
    if (
      !isWorkFactSourceId(input.sourceId) ||
      ranAt === null ||
      !validMachineId(input.machineId) ||
      input.machineId === undefined ||
      !(Number.isSafeInteger(input.observed) && input.observed >= 0) ||
      !(Number.isSafeInteger(input.failed) && input.failed >= 0) ||
      !(input.message === null || typeof input.message === 'string')
    ) {
      return Effect.fail(
        usageStoreError('recordWorkFactRun', input.dbPath, 'Work fact run state is invalid', 'invalid-input'),
      );
    }
    const message = input.message === null ? null : input.message.slice(0, WORK_ATTENTION_BOUNDS.maxDetailText);
    return withUsageStoreWriter(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const existing = db
            .query('SELECT * FROM work_fact_run_state WHERE source_id = ?')
            .get(input.sourceId) as RunStateRecord | null;
          db.query(`
            INSERT INTO work_fact_run_state (source_id, machine_id, ran_at, observed, failed, disabled, message)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET
              machine_id = excluded.machine_id,
              ran_at = excluded.ran_at,
              observed = excluded.observed,
              failed = excluded.failed,
              disabled = excluded.disabled,
              message = excluded.message
          `).run(input.sourceId, input.machineId, ranAt, input.observed, input.failed, input.disabled ? 1 : 0, message);
          const changed =
            existing === null ||
            existing.machine_id !== input.machineId ||
            existing.ran_at !== ranAt ||
            existing.observed !== input.observed ||
            existing.failed !== input.failed ||
            existing.disabled !== (input.disabled ? 1 : 0) ||
            existing.message !== message;
          return { changed };
        },
        catch: (cause) => usageStoreError('recordWorkFactRun', input.dbPath, cause, 'storage-failure'),
      }),
    );
  };

  const queryLatestPullRequestObservations = (
    input: QueryLatestPullRequestObservationsInput,
  ): Effect.Effect<LatestPullRequestObservations, UsageStoreError> => {
    const limit = validLimit(input.limit);
    const links = input.links ?? [];
    if (
      limit === null ||
      !validMachineId(input.machineId) ||
      links.length > MAX_WORK_FACT_QUERY_LIMIT ||
      links.some(
        (link) =>
          typeof link.host !== 'string' ||
          typeof link.repository !== 'string' ||
          !Number.isSafeInteger(link.number) ||
          link.number <= 0,
      )
    ) {
      return Effect.fail(
        usageStoreError(
          'queryLatestPullRequestObservations',
          input.dbPath,
          'Pull request observation query is out of bounds',
          'invalid-input',
        ),
      );
    }
    const linkFilter =
      links.length === 0 ? '' : `AND (${links.map(() => '(host = ? AND repository = ? AND number = ?)').join(' OR ')})`;
    const linkParams = links.flatMap((link) => [link.host, link.repository, link.number]);
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const records = db
            .query(`
              WITH ranked AS (
                SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY machine_id, host, repository, number
                    ORDER BY observed_at DESC, id DESC
                  ) AS rank_all,
                  ROW_NUMBER() OVER (
                    PARTITION BY machine_id, host, repository, number, outcome = 'observed'
                    ORDER BY observed_at DESC, id DESC
                  ) AS rank_outcome,
                  MAX(observed_at) OVER (PARTITION BY machine_id, host, repository, number) AS key_latest
                FROM pull_request_observations
                WHERE (? IS NULL OR machine_id = ?) ${linkFilter}
              )
              SELECT * FROM ranked
              WHERE rank_all = 1 OR (outcome = 'observed' AND rank_outcome = 1)
              ORDER BY key_latest DESC, machine_id, host, repository, number, rank_all
              LIMIT ?
            `)
            .all(
              input.machineId ?? null,
              input.machineId ?? null,
              ...linkParams,
              2 * (limit + 1),
            ) as PullRequestRecord[];
          return groupLatest(
            records,
            (record) => JSON.stringify([record.machine_id, record.host, record.repository, record.number]),
            (record) => parsePullRequestObservation(pullRequestValue(record)),
            limit,
          );
        },
        catch: (cause) => usageStoreReadError('queryLatestPullRequestObservations', input.dbPath, cause),
      }),
    );
  };

  const queryLatestCheckoutStatusObservations = (
    input: QueryLatestCheckoutStatusObservationsInput,
  ): Effect.Effect<LatestCheckoutStatusObservations, UsageStoreError> => {
    const limit = validLimit(input.limit);
    const paths = input.paths ?? [];
    if (
      limit === null ||
      !validMachineId(input.machineId) ||
      paths.length > MAX_WORK_FACT_QUERY_LIMIT ||
      paths.some((candidate) => typeof candidate !== 'string' || candidate.length === 0)
    ) {
      return Effect.fail(
        usageStoreError(
          'queryLatestCheckoutStatusObservations',
          input.dbPath,
          'Checkout status observation query is out of bounds',
          'invalid-input',
        ),
      );
    }
    const pathFilter = paths.length === 0 ? '' : `AND checkout_path IN (${paths.map(() => '?').join(', ')})`;
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const records = db
            .query(`
              WITH ranked AS (
                SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY machine_id, checkout_path
                    ORDER BY observed_at DESC, id DESC
                  ) AS rank_all,
                  ROW_NUMBER() OVER (
                    PARTITION BY machine_id, checkout_path, outcome = 'observed'
                    ORDER BY observed_at DESC, id DESC
                  ) AS rank_outcome,
                  MAX(observed_at) OVER (PARTITION BY machine_id, checkout_path) AS key_latest
                FROM checkout_status_observations
                WHERE (? IS NULL OR machine_id = ?) ${pathFilter}
              )
              SELECT * FROM ranked
              WHERE rank_all = 1 OR (outcome = 'observed' AND rank_outcome = 1)
              ORDER BY key_latest DESC, machine_id, checkout_path, rank_all
              LIMIT ?
            `)
            .all(input.machineId ?? null, input.machineId ?? null, ...paths, 2 * (limit + 1)) as CheckoutStatusRecord[];
          return groupLatest(
            records,
            (record) => JSON.stringify([record.machine_id, record.checkout_path]),
            (record) => parseCheckoutStatusObservation(checkoutStatusValue(record)),
            limit,
          );
        },
        catch: (cause) => usageStoreReadError('queryLatestCheckoutStatusObservations', input.dbPath, cause),
      }),
    );
  };

  const queryLatestJiraIssueObservations = (
    input: QueryLatestJiraIssueObservationsInput,
  ): Effect.Effect<LatestJiraIssueObservations, UsageStoreError> => {
    const limit = validLimit(input.limit);
    const keys = input.keys ?? [];
    if (
      limit === null ||
      !validMachineId(input.machineId) ||
      keys.length > MAX_WORK_FACT_QUERY_LIMIT ||
      keys.some((key) => typeof key !== 'string' || !JIRA_ISSUE_KEY_PATTERN.test(key))
    ) {
      return Effect.fail(
        usageStoreError(
          'queryLatestJiraIssueObservations',
          input.dbPath,
          'Jira issue observation query is out of bounds',
          'invalid-input',
        ),
      );
    }
    const keyFilter = keys.length === 0 ? '' : `AND issue_key IN (${keys.map(() => '?').join(', ')})`;
    return withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const records = db
            .query(`
              WITH ranked AS (
                SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY machine_id, issue_key
                    ORDER BY observed_at DESC, id DESC
                  ) AS rank_all,
                  ROW_NUMBER() OVER (
                    PARTITION BY machine_id, issue_key, outcome = 'observed'
                    ORDER BY observed_at DESC, id DESC
                  ) AS rank_outcome,
                  MAX(observed_at) OVER (PARTITION BY machine_id, issue_key) AS key_latest
                FROM jira_issue_observations
                WHERE (? IS NULL OR machine_id = ?) ${keyFilter}
              )
              SELECT * FROM ranked
              WHERE rank_all = 1 OR (outcome = 'observed' AND rank_outcome = 1)
              ORDER BY key_latest DESC, machine_id, issue_key, rank_all
              LIMIT ?
            `)
            .all(input.machineId ?? null, input.machineId ?? null, ...keys, 2 * (limit + 1)) as JiraIssueRecord[];
          return groupLatest(
            records,
            (record) => JSON.stringify([record.machine_id, record.issue_key]),
            (record) => parseJiraIssueObservation(jiraIssueValue(record)),
            limit,
          );
        },
        catch: (cause) => usageStoreReadError('queryLatestJiraIssueObservations', input.dbPath, cause),
      }),
    );
  };

  const queryWorkFactRunStates = (
    input: QueryWorkFactRunStatesInput,
  ): Effect.Effect<WorkFactRunStates, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (db) =>
      Effect.try({
        try: () => {
          const records = db.query('SELECT * FROM work_fact_run_state ORDER BY source_id').all() as RunStateRecord[];
          const runs: WorkFactRunState[] = [];
          let skipped = 0;
          for (const record of records) {
            const ranAt: CanonicalInstant | null = normalizeIsoTimestamp(record.ran_at);
            if (
              !isWorkFactSourceId(record.source_id) ||
              ranAt === null ||
              typeof record.machine_id !== 'string' ||
              record.machine_id.length === 0 ||
              !(Number.isSafeInteger(record.observed) && record.observed >= 0) ||
              !(Number.isSafeInteger(record.failed) && record.failed >= 0) ||
              !(record.disabled === 0 || record.disabled === 1) ||
              !(record.message === null || typeof record.message === 'string')
            ) {
              skipped += 1;
              continue;
            }
            runs.push({
              disabled: record.disabled === 1,
              failed: record.failed,
              machineId: record.machine_id,
              message: record.message,
              observed: record.observed,
              ranAt,
              sourceId: record.source_id,
            });
          }
          return { runs, skipped };
        },
        catch: (cause) => usageStoreReadError('queryWorkFactRunStates', input.dbPath, cause),
      }),
    );

  return {
    importCheckoutStatusObservations,
    importJiraIssueObservations,
    importPullRequestObservations,
    queryLatestCheckoutStatusObservations,
    queryLatestJiraIssueObservations,
    queryLatestPullRequestObservations,
    queryWorkFactRunStates,
    recordWorkFactRun,
  };
};
