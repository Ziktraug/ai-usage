import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type {
  CheckoutStatusObservation,
  JiraIssueObservation,
  PullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import {
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryUsageStoreGeneration,
  queryWorkFactRunStates,
  type UsageStoreError,
} from './reader';
import { MAX_WORK_THREAD_CHECKOUT_KEYS, MAX_WORK_THREAD_FACT_KEYS, migrateWorkFactSchema } from './work-fact-store';
import {
  importCheckoutStatusObservations,
  importJiraIssueObservations,
  importPullRequestObservations,
  initializeUsageStore,
  recordWorkFactRun,
} from './writer';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createStore = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), `usage-store-work-facts-${name}-`));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const at = (minute: number): CanonicalInstant =>
  parseCanonicalInstant(`2026-10-21T20:${String(minute).padStart(2, '0')}:00.000Z`);

const pullRequest = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation =>
  ({
    accountLabel: null,
    baseRef: 'main',
    checksRollup: 'success',
    discoveryRole: null,
    draft: false,
    headRef: 'feat/work-view',
    host: 'github.com',
    machineId: 'machine-a',
    mergeable: null,
    mergeStateStatus: null,
    mergedAt: null,
    number: 66,
    observedAt: at(0),
    outcome: 'observed',
    outcomeMessage: null,
    repository: 'fixture/project',
    reviewDecision: 'REVIEW_REQUIRED',
    state: 'OPEN',
    title: 'Add the Work view',
    updatedAt: parseCanonicalInstant('2026-10-21T18:30:00.000Z'),
    url: 'https://github.com/fixture/project/pull/66',
    ...overrides,
  }) as PullRequestObservation;

const failedPullRequest = (minute: number, overrides: Partial<PullRequestObservation> = {}): PullRequestObservation =>
  pullRequest({
    baseRef: null,
    checksRollup: null,
    draft: null,
    headRef: null,
    mergedAt: null,
    observedAt: at(minute),
    outcome: 'network',
    outcomeMessage: 'gh exited 1 without output (network failure or not found)',
    reviewDecision: null,
    state: null,
    title: null,
    updatedAt: null,
    url: null,
    ...overrides,
  });

const checkout = (overrides: Partial<CheckoutStatusObservation> = {}): CheckoutStatusObservation =>
  ({
    ahead: 1,
    behind: 0,
    branch: 'feat/work-view',
    checkoutPath: '/home/alex/projects/example',
    dirty: true,
    headSha: 'a'.repeat(40),
    lastCommitAt: parseCanonicalInstant('2026-10-20T10:00:00.000Z'),
    machineId: 'machine-a',
    modifiedCount: 2,
    observedAt: at(0),
    outcome: 'observed',
    stagedCount: 1,
    untrackedCount: 3,
    upstream: 'origin/feat/work-view',
    ...overrides,
  }) as CheckoutStatusObservation;

const failedCheckout = (
  minute: number,
  overrides: Partial<CheckoutStatusObservation> = {},
): CheckoutStatusObservation =>
  checkout({
    ahead: null,
    behind: null,
    branch: null,
    dirty: null,
    headSha: null,
    lastCommitAt: null,
    modifiedCount: null,
    observedAt: at(minute),
    outcome: 'timeout',
    stagedCount: null,
    untrackedCount: null,
    upstream: null,
    ...overrides,
  });

const rowCount = (dbPath: string, table: string): number => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
};

const failureReason = async (effect: Effect.Effect<unknown, UsageStoreError>): Promise<string | undefined> => {
  const result = await Effect.runPromise(Effect.result(effect));
  return result._tag === 'Failure' ? result.failure.reason : undefined;
};

describe('work fact store: pull request observations', () => {
  test('reads legacy columns without migration and adds nullable columns on the next import', async () => {
    const dbPath = await createStore('legacy-discovery');
    await Effect.runPromise(importPullRequestObservations({ dbPath, observations: [pullRequest()] }));
    const legacy = new Database(dbPath);
    for (const column of ['discovery_role', 'mergeable', 'merge_state_status']) {
      legacy.exec(`ALTER TABLE pull_request_observations DROP COLUMN ${column}`);
    }
    legacy.close();
    const before = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath }));
    expect(before.items[0]?.latestObserved).toEqual(pullRequest());
    const observed = pullRequest({
      discoveryRole: 'author',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      observedAt: at(1),
    });
    await Effect.runPromise(importPullRequestObservations({ dbPath, observations: [observed] }));
    expect((await Effect.runPromise(queryLatestPullRequestObservations({ dbPath }))).items[0]?.latestObserved).toEqual(
      observed,
    );
    const migrated = new Database(dbPath);
    expect(
      migrated
        .query(
          'SELECT discovery_role, mergeable, merge_state_status FROM pull_request_observations ORDER BY observed_at DESC LIMIT 1',
        )
        .get(),
    ).toEqual({ discovery_role: 'author', mergeable: 'MERGEABLE', merge_state_status: 'BEHIND' });
    expect(migrateWorkFactSchema(migrated as unknown as Parameters<typeof migrateWorkFactSchema>[0])).toBe(false);
    migrated.close();
  });

  test('keeps the latest observation and the latest successful one apart, and re-imports idempotently', async () => {
    const dbPath = await createStore('pull-requests');
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    const batch = [pullRequest(), failedPullRequest(5)];
    expect(await Effect.runPromise(importPullRequestObservations({ dbPath, observations: batch }))).toEqual({
      inserted: 2,
      pruned: 0,
      rejected: 0,
      unchanged: 0,
    });
    expect(await Effect.runPromise(importPullRequestObservations({ dbPath, observations: batch }))).toEqual({
      inserted: 0,
      pruned: 0,
      rejected: 0,
      unchanged: 2,
    });
    const latest = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath }));
    expect(latest).toEqual({
      items: [{ latest: failedPullRequest(5), latestObserved: pullRequest() }],
      skipped: 0,
      truncated: false,
    });
    // Facts live outside the served revision: nothing here moves the store generation.
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationBefore);
  });

  test('retains five rows per pull request plus the newest successful one through a failure streak', async () => {
    const dbPath = await createStore('retention');
    await Effect.runPromise(importPullRequestObservations({ dbPath, observations: [pullRequest()] }));
    const failures = [1, 2, 3, 4, 5, 6, 7].map((minute) => failedPullRequest(minute));
    const result = await Effect.runPromise(importPullRequestObservations({ dbPath, observations: failures }));
    expect(result).toMatchObject({ inserted: 7, pruned: 2 });
    expect(rowCount(dbPath, 'pull_request_observations')).toBe(6);
    const latest = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath }));
    expect(latest.items).toEqual([{ latest: failedPullRequest(7), latestObserved: pullRequest() }]);
  });

  test('counts rejected rows on import and skipped rows on read instead of dropping them silently', async () => {
    const dbPath = await createStore('validation');
    expect(
      await Effect.runPromise(
        importPullRequestObservations({ dbPath, observations: [pullRequest(), { number: 'sixty-six' }, null] }),
      ),
    ).toMatchObject({ inserted: 1, rejected: 2 });
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO pull_request_observations (machine_id, host, repository, number, observed_at, outcome)
       VALUES ('machine-a', 'github.com', 'fixture/other', 9, ?, 'bogus-outcome')`,
    ).run(at(9));
    db.close();
    const latest = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath }));
    expect(latest.skipped).toBe(1);
    expect(latest.items.map(({ latest: { number } }) => number)).toEqual([66]);
  });

  test('filters by machine and by explicit links, orders by recency and reports truncation', async () => {
    const dbPath = await createStore('filters');
    await Effect.runPromise(
      importPullRequestObservations({
        dbPath,
        observations: [
          pullRequest({ number: 1, observedAt: at(1), url: 'https://github.com/fixture/project/pull/1' }),
          pullRequest({ number: 2, observedAt: at(3), url: 'https://github.com/fixture/project/pull/2' }),
          pullRequest({ number: 3, observedAt: at(2), url: 'https://github.com/fixture/project/pull/3' }),
          pullRequest({
            machineId: 'machine-b',
            number: 1,
            observedAt: at(4),
            url: 'https://github.com/fixture/project/pull/1',
          }),
          pullRequest({
            number: 1,
            observedAt: at(5),
            repository: 'other/project',
            url: 'https://github.com/other/project/pull/1',
          }),
        ],
      }),
    );
    const bounded = await Effect.runPromise(
      queryLatestPullRequestObservations({ dbPath, limit: 2, machineId: 'machine-a' }),
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.items.map(({ latest }) => [latest.repository, latest.number])).toEqual([
      ['other/project', 1],
      ['fixture/project', 2],
    ]);
    const linked = await Effect.runPromise(
      queryLatestPullRequestObservations({
        dbPath,
        links: [{ host: 'github.com', number: 1, repository: 'fixture/project' }],
      }),
    );
    // The same number on another repository is never confused with this one; both machines report.
    expect(linked.items.map(({ latest }) => [latest.machineId, latest.repository, latest.number])).toEqual([
      ['machine-b', 'fixture/project', 1],
      ['machine-a', 'fixture/project', 1],
    ]);
    expect(await failureReason(queryLatestPullRequestObservations({ dbPath, limit: 501 }))).toBe('invalid-input');
    expect(await failureReason(queryLatestPullRequestObservations({ dbPath, limit: 0 }))).toBe('invalid-input');
    expect(
      await failureReason(
        importPullRequestObservations({ dbPath, observations: Array.from({ length: 501 }, () => pullRequest()) }),
      ),
    ).toBe('invalid-input');
  });
});

describe('work fact store: checkout status observations', () => {
  test('round-trips observations and keeps the last successful look beside a failure', async () => {
    const dbPath = await createStore('checkouts');
    const other = checkout({ checkoutPath: '/home/alex/projects/other', dirty: false, modifiedCount: 0 });
    expect(
      await Effect.runPromise(
        importCheckoutStatusObservations({ dbPath, observations: [checkout(), failedCheckout(2), other, 'nope'] }),
      ),
    ).toEqual({ inserted: 3, pruned: 0, rejected: 1, unchanged: 0 });
    const all = await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }));
    expect(all.items).toEqual([
      { countsChangedAt: null, latest: failedCheckout(2), latestObserved: checkout() },
      { countsChangedAt: null, latest: other, latestObserved: other },
    ]);
    const filtered = await Effect.runPromise(
      queryLatestCheckoutStatusObservations({ dbPath, paths: ['/home/alex/projects/other'] }),
    );
    expect(filtered.items).toEqual([{ countsChangedAt: null, latest: other, latestObserved: other }]);
    expect(filtered.skipped).toBe(0);
  });

  test('retains five rows per checkout plus the newest successful one', async () => {
    const dbPath = await createStore('checkout-retention');
    await Effect.runPromise(importCheckoutStatusObservations({ dbPath, observations: [checkout()] }));
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [1, 2, 3, 4, 5, 6].map((minute) => failedCheckout(minute)),
      }),
    );
    expect(rowCount(dbPath, 'checkout_status_observations')).toBe(6);
    const latest = await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }));
    expect(latest.items).toEqual([{ countsChangedAt: null, latest: failedCheckout(6), latestObserved: checkout() }]);
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(7) })] }),
    );
    expect(rowCount(dbPath, 'checkout_status_observations')).toBe(5);
  });

  test('count activity requires a proven change and survives polls, failures, retention and late imports', async () => {
    const dbPath = await createStore('checkout-activity');
    const read = async () =>
      (await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath, machineId: 'machine-a' }))).items[0]
        ?.countsChangedAt;
    await Effect.runPromise(importCheckoutStatusObservations({ dbPath, observations: [checkout()] }));
    expect(await read()).toBeNull();
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(1) })] }),
    );
    expect(await read()).toBeNull();
    // A shuffled batch is compared by observation time, never import order.
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [
          checkout({ observedAt: at(4), modifiedCount: 8 }),
          checkout({ observedAt: at(2), modifiedCount: 8 }),
          failedCheckout(3),
          checkout({ machineId: 'machine-b', observedAt: at(5), modifiedCount: 99 }),
        ],
      }),
    );
    expect(await read()).toBe(at(2));
    for (let minute = 5; minute < 13; minute++) {
      await Effect.runPromise(
        importCheckoutStatusObservations({
          dbPath,
          observations: [checkout({ observedAt: at(minute), modifiedCount: 8 })],
        }),
      );
    }
    expect(await read()).toBe(at(2));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [failedCheckout(13), failedCheckout(14)] }),
    );
    expect(await read()).toBe(at(2));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(15), modifiedCount: 9 })] }),
    );
    expect(await read()).toBe(at(15));
    // Late history does not stamp the current poll time onto an already proven change.
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(14), modifiedCount: 8 })] }),
    );
    expect(await read()).toBe(at(15));
  });

  test('backfilled evidence moves a proven count change earlier without losing a retained baseline', async () => {
    const dbPath = await createStore('checkout-activity-backfill');
    const read = async () =>
      (await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }))).items[0]?.countsChangedAt;
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [
          checkout({ observedAt: at(10), modifiedCount: 0 }),
          checkout({ observedAt: at(12), modifiedCount: 1 }),
        ],
      }),
    );
    expect(await read()).toBe(at(12));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(11), modifiedCount: 1 })] }),
    );
    expect(await read()).toBe(at(11));
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [13, 14, 15, 16, 17, 18].map((minute) => failedCheckout(minute)),
      }),
    );
    // Only one success survives; its predecessor and the actual change observation have been pruned.
    expect(rowCount(dbPath, 'checkout_status_observations')).toBe(6);
    expect(await read()).toBe(at(11));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(19), modifiedCount: 1 })] }),
    );
    expect(await read()).toBe(at(11));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(20), modifiedCount: 2 })] }),
    );
    expect(await read()).toBe(at(20));
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [21, 22, 23, 24, 25, 26].map((minute) => failedCheckout(minute)),
      }),
    );
    // A sole retained success may itself be the observation where the counts changed.
    expect(await read()).toBe(at(20));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(27), modifiedCount: 2 })] }),
    );
    expect(await read()).toBe(at(20));
  });

  test('backfilled observations before retained history preserve its proven change checkpoint', async () => {
    const dbPath = await createStore('checkout-activity-retained-backfill');
    const read = async () =>
      (await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }))).items[0]?.countsChangedAt;
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [
          checkout({ observedAt: at(10), modifiedCount: 0 }),
          checkout({ observedAt: at(12), modifiedCount: 1 }),
        ],
      }),
    );
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(11), modifiedCount: 1 })] }),
    );
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [13, 14, 15, 16, 17, 18, 19, 20].map((minute) =>
          checkout({ observedAt: at(minute), modifiedCount: 1 }),
        ),
      }),
    );
    expect(await read()).toBe(at(11));
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(10), modifiedCount: 0 })] }),
    );
    expect(await read()).toBe(at(11));
  });

  test('unknown counts cannot establish change and legacy readers remain read-only before migration', async () => {
    const dbPath = await createStore('checkout-legacy-activity');
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [checkout({ modifiedCount: null }), checkout({ observedAt: at(1), modifiedCount: 8 })],
      }),
    );
    expect(
      (await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }))).items[0]?.countsChangedAt,
    ).toBeNull();
    const legacy = new Database(dbPath);
    legacy.exec('ALTER TABLE checkout_status_observations DROP COLUMN counts_changed_at');
    legacy.exec('ALTER TABLE work_fact_run_state DROP COLUMN outcome_code');
    legacy.close();
    expect(
      (await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }))).items[0]?.countsChangedAt,
    ).toBeNull();
    expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).runs).toEqual([]);
    const before = new Database(dbPath, { readonly: true });
    expect(
      before
        .query('PRAGMA table_info(checkout_status_observations)')
        .all()
        .some(
          (column) =>
            typeof column === 'object' && column !== null && 'name' in column && column.name === 'counts_changed_at',
        ),
    ).toBe(false);
    before.close();
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(2), modifiedCount: 9 })] }),
    );
    expect((await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath }))).items[0]?.countsChangedAt).toBe(
      at(2),
    );
  });
});

describe('work fact store: run state', () => {
  test('persists and clears a typed discovery authentication outcome without parsing messages', async () => {
    const dbPath = await createStore('typed-outcome');
    const input = {
      dbPath,
      machineId: 'machine-a',
      sourceId: 'github.pull-requests' as const,
      ranAt: at(0),
      disabled: false,
      failed: 1,
      observed: 0,
      message: 'fixture',
      outcomeCode: 'unauthenticated' as const,
    };
    expect(await Effect.runPromise(recordWorkFactRun(input))).toEqual({ changed: true });
    expect(await Effect.runPromise(recordWorkFactRun(input))).toEqual({ changed: false });
    expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).runs[0]?.outcomeCode).toBe('unauthenticated');
    expect(await Effect.runPromise(recordWorkFactRun({ ...input, outcomeCode: null }))).toEqual({ changed: true });
    expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).runs[0]?.outcomeCode).toBeNull();
    expect(await failureReason(recordWorkFactRun({ ...input, outcomeCode: 'arbitrary' as 'unauthenticated' }))).toBe(
      'invalid-input',
    );
    const corrupt = new Database(dbPath);
    corrupt.exec('PRAGMA ignore_check_constraints = ON');
    corrupt.exec("UPDATE work_fact_run_state SET outcome_code = 'arbitrary'");
    corrupt.close();
    expect(await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).toEqual({ runs: [], skipped: 1 });
  });

  test('records one row per source, reports change, and validates the input', async () => {
    const dbPath = await createStore('runs');
    const run = {
      dbPath,
      disabled: false,
      failed: 1,
      machineId: 'machine-a',
      message: null,
      observed: 3,
      ranAt: new Date(at(0)),
      sourceId: 'checkouts.status' as const,
    };
    expect(await Effect.runPromise(recordWorkFactRun(run))).toEqual({ changed: true });
    expect(await Effect.runPromise(recordWorkFactRun(run))).toEqual({ changed: false });
    expect(
      await Effect.runPromise(
        recordWorkFactRun({
          ...run,
          disabled: true,
          failed: 0,
          message: 'github.enabled is false in the local config',
          observed: 0,
          sourceId: 'github.pull-requests',
        }),
      ),
    ).toEqual({ changed: true });
    expect(await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).toEqual({
      runs: [
        {
          disabled: false,
          failed: 1,
          machineId: 'machine-a',
          message: null,
          observed: 3,
          outcomeCode: null,
          ranAt: at(0),
          sourceId: 'checkouts.status',
        },
        {
          disabled: true,
          failed: 0,
          machineId: 'machine-a',
          message: 'github.enabled is false in the local config',
          observed: 0,
          outcomeCode: null,
          ranAt: at(0),
          sourceId: 'github.pull-requests',
        },
      ],
      skipped: 0,
    });
    expect(
      await failureReason(recordWorkFactRun({ ...run, sourceId: 'claude.sessions' as unknown as 'checkouts.status' })),
    ).toBe('invalid-input');
    expect(await failureReason(recordWorkFactRun({ ...run, failed: -1 }))).toBe('invalid-input');
  });
});

const jiraIssue = (overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation =>
  ({
    assigneeLabel: 'Alex',
    commentCount: 2,
    comments: [
      { authorLabel: 'Sam', createdAt: parseCanonicalInstant('2026-10-21T18:30:00.000Z'), excerpt: 'Second.', id: '2' },
      { authorLabel: 'Sam', createdAt: parseCanonicalInstant('2026-10-20T08:00:00.000Z'), excerpt: 'First.', id: '1' },
    ],
    key: 'XLB-2090',
    machineId: 'machine-a',
    observedAt: at(0),
    outcome: 'observed',
    outcomeMessage: null,
    parentKey: 'XLB-2000',
    sprint: 'Sprint 42',
    status: 'In Progress',
    statusCategory: 'in-progress',
    summary: 'Promo badge',
    updatedAt: parseCanonicalInstant('2026-10-21T18:30:00.000Z'),
    ...overrides,
  }) as JiraIssueObservation;

const failedJiraIssue = (minute: number, overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation =>
  jiraIssue({
    assigneeLabel: null,
    commentCount: null,
    comments: [],
    observedAt: at(minute),
    outcome: 'unauthenticated',
    outcomeMessage: 'Jira rejected the credentials (HTTP 401); sign in to Jira (acli jira auth login)',
    parentKey: null,
    sprint: null,
    status: null,
    statusCategory: null,
    summary: null,
    updatedAt: null,
    ...overrides,
  });

describe('work fact store: Jira issue observations', () => {
  test('stores the comments as JSON, re-validates on read, and keeps the last success beside a failure', async () => {
    const dbPath = await createStore('jira');
    expect(
      await Effect.runPromise(
        importJiraIssueObservations({
          dbPath,
          observations: [
            jiraIssue(),
            jiraIssue(), // same identity and instant: unchanged
            jiraIssue({ key: 'XLB-2091', machineId: 'machine-b', observedAt: at(1) }),
            { ...jiraIssue(), key: 'xlb-2090' }, // not an issue key: rejected
            { ...jiraIssue(), comments: [{ authorLabel: 'sam@example.com', createdAt: at(0), excerpt: '', id: '9' }] },
          ],
        }),
      ),
    ).toEqual({ inserted: 2, pruned: 0, rejected: 2, unchanged: 1 });
    expect(
      await Effect.runPromise(importJiraIssueObservations({ dbPath, observations: [failedJiraIssue(5)] })),
    ).toEqual({ inserted: 1, pruned: 0, rejected: 0, unchanged: 0 });

    const all = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath }));
    expect(all.skipped).toBe(0);
    expect(all.truncated).toBe(false);
    expect(
      all.items.map(({ latest, latestObserved }) => [latest.key, latest.outcome, latestObserved?.observedAt]),
    ).toEqual([
      ['XLB-2090', 'unauthenticated', at(0)],
      ['XLB-2091', 'observed', at(1)],
    ]);
    expect(all.items[0]?.latestObserved).toEqual(jiraIssue());
    expect(all.items[0]?.latest).toEqual(failedJiraIssue(5));

    const filtered = await Effect.runPromise(
      queryLatestJiraIssueObservations({ dbPath, keys: ['XLB-2091', 'XLB-9'], machineId: 'machine-b' }),
    );
    expect(filtered.items.map(({ latest }) => latest.key)).toEqual(['XLB-2091']);
    expect((await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath, keys: ['XLB-9'] }))).items).toEqual([]);
    const invalid = await Effect.runPromise(
      Effect.flip(queryLatestJiraIssueObservations({ dbPath, keys: ['not a key'] })),
    );
    expect((invalid as UsageStoreError).reason).toBe('invalid-input');
  });

  test('retains five rows per issue plus the newest success, and skips a row whose comments no longer parse', async () => {
    const dbPath = await createStore('jira-retention');
    await Effect.runPromise(importJiraIssueObservations({ dbPath, observations: [jiraIssue()] }));
    const failures = Array.from({ length: 6 }, (_value, index) => failedJiraIssue(index + 1));
    const result = await Effect.runPromise(importJiraIssueObservations({ dbPath, observations: failures }));
    expect(result.inserted).toBe(6);
    expect(result.pruned).toBe(1);
    expect(rowCount(dbPath, 'jira_issue_observations')).toBe(6);
    const latest = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath }));
    expect(latest.items[0]?.latest.observedAt).toBe(at(6));
    expect(latest.items[0]?.latestObserved?.observedAt).toBe(at(0));

    const db = new Database(dbPath);
    db.run("UPDATE jira_issue_observations SET comments_json = '{not json' WHERE observed_at = ?", [at(0)]);
    db.close();
    const degraded = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath }));
    expect(degraded.skipped).toBe(1);
    expect(degraded.items[0]?.latestObserved).toBeNull();
  });

  test('records a jira.issues run state beside the other producers', async () => {
    const dbPath = await createStore('jira-run');
    expect(
      await Effect.runPromise(
        recordWorkFactRun({
          dbPath,
          disabled: true,
          failed: 0,
          machineId: 'machine-a',
          message: 'acli not installed',
          observed: 0,
          ranAt: new Date(at(0)),
          sourceId: 'jira.issues',
        }),
      ),
    ).toEqual({ changed: true });
    expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).runs).toEqual([
      {
        disabled: true,
        failed: 0,
        machineId: 'machine-a',
        message: 'acli not installed',
        observed: 0,
        outcomeCode: null,
        ranAt: at(0),
        sourceId: 'jira.issues',
      },
    ]);
  });
});

describe('work fact store: exact page batches', () => {
  test('joins mixed-case PR history to normalized keys while isolating machines and numbers', async () => {
    const dbPath = await createStore('page-pr-casing');
    const success = pullRequest({ host: 'GitHub.COM', repository: 'Fixture/Project', observedAt: at(2) });
    const failure = failedPullRequest(3, { repository: 'FIXTURE/project' });
    const second = pullRequest({ machineId: 'machine-b', number: 7, observedAt: at(1) });
    await Effect.runPromise(
      importPullRequestObservations({
        dbPath,
        observations: [
          pullRequest(),
          success,
          failure,
          second,
          pullRequest({ machineId: 'machine-b', observedAt: at(5) }),
          pullRequest({ number: 7, observedAt: at(5) }),
          pullRequest({ host: 'other.example', observedAt: at(5) }),
        ],
      }),
    );
    const result = await Effect.runPromise(
      queryLatestPullRequestObservations({
        dbPath,
        batch: [
          { host: 'github.com', repository: 'fixture/project', number: 66, machineId: 'machine-a' },
          { host: 'GITHUB.COM', repository: 'fixture/PROJECT', number: 7, machineId: 'machine-b' },
        ],
      }),
    );
    expect(result).toEqual({
      items: [
        { latest: failure, latestObserved: success },
        { latest: second, latestObserved: second },
      ],
      skipped: 0,
      truncated: false,
    });
  });

  test('batches Jira and checkout identities without mixing same-key histories across machines', async () => {
    const dbPath = await createStore('page-machine-isolation');
    const secondCheckout = checkout({ machineId: 'machine-b', checkoutPath: '/other', observedAt: at(1) });
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [
          checkout(),
          failedCheckout(3),
          secondCheckout,
          checkout({ machineId: 'machine-b', observedAt: at(5) }),
          checkout({ checkoutPath: '/other', observedAt: at(5) }),
        ],
      }),
    );
    expect(
      await Effect.runPromise(
        queryLatestCheckoutStatusObservations({
          dbPath,
          batch: [checkout(), secondCheckout],
        }),
      ),
    ).toEqual({
      items: [
        { countsChangedAt: null, latest: failedCheckout(3), latestObserved: checkout() },
        { countsChangedAt: null, latest: secondCheckout, latestObserved: secondCheckout },
      ],
      skipped: 0,
      truncated: false,
    });
    const secondJira = jiraIssue({ machineId: 'machine-b', key: 'XLB-7', observedAt: at(1) });
    await Effect.runPromise(
      importJiraIssueObservations({
        dbPath,
        observations: [
          jiraIssue(),
          failedJiraIssue(3),
          secondJira,
          jiraIssue({ machineId: 'machine-b', observedAt: at(5) }),
          jiraIssue({ key: 'XLB-7', observedAt: at(5) }),
        ],
      }),
    );
    expect(
      await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath, batch: [jiraIssue(), secondJira] })),
    ).toEqual({
      items: [
        { latest: failedJiraIssue(3), latestObserved: jiraIssue() },
        { latest: secondJira, latestObserved: secondJira },
      ],
      skipped: 0,
      truncated: false,
    });
  });

  test('empty page batches read no unscoped observations', async () => {
    const dbPath = await createStore('page-empty');
    await Effect.runPromise(importPullRequestObservations({ dbPath, observations: [pullRequest()] }));
    await Effect.runPromise(importJiraIssueObservations({ dbPath, observations: [jiraIssue()] }));
    await Effect.runPromise(importCheckoutStatusObservations({ dbPath, observations: [checkout()] }));
    for (const result of await Promise.all([
      Effect.runPromise(queryLatestPullRequestObservations({ dbPath, batch: [] })),
      Effect.runPromise(queryLatestJiraIssueObservations({ dbPath, batch: [] })),
      Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath, batch: [] })),
    ])) {
      expect(result).toEqual({ items: [], skipped: 0, truncated: false });
    }
  });

  test('returns more than 500 exact identities without the generic query ceiling or SQL expression limit', async () => {
    const dbPath = await createStore('page-large');
    const pullRequests = Array.from({ length: 501 }, (_, index) => pullRequest({ number: index + 1 }));
    const jiraIssues = Array.from({ length: 501 }, (_, index) => jiraIssue({ key: `XLB-${index + 1}` }));
    const checkouts = Array.from({ length: 501 }, (_, index) => checkout({ checkoutPath: `/checkout/${index}` }));
    for (let start = 0; start < 501; start += 500) {
      await Effect.runPromise(
        importPullRequestObservations({ dbPath, observations: pullRequests.slice(start, start + 500) }),
      );
      await Effect.runPromise(
        importJiraIssueObservations({ dbPath, observations: jiraIssues.slice(start, start + 500) }),
      );
      await Effect.runPromise(
        importCheckoutStatusObservations({ dbPath, observations: checkouts.slice(start, start + 500) }),
      );
    }
    for (const result of await Promise.all([
      Effect.runPromise(queryLatestPullRequestObservations({ dbPath, batch: pullRequests })),
      Effect.runPromise(queryLatestJiraIssueObservations({ dbPath, batch: jiraIssues })),
      Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath, batch: checkouts })),
    ])) {
      expect(result.items).toHaveLength(501);
      expect(result.skipped).toBe(0);
      expect(result.truncated).toBe(false);
    }
    const duplicateKeys = Array.from({ length: MAX_WORK_THREAD_FACT_KEYS }, () => pullRequest());
    expect(
      (await Effect.runPromise(queryLatestPullRequestObservations({ dbPath, batch: duplicateKeys }))).items,
    ).toHaveLength(1);
    const generic = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath, limit: 500 }));
    expect(generic.items).toHaveLength(500);
    expect(generic.truncated).toBe(true);
  });

  test('rejects oversized or invalid exact batches and preserves the generic ceiling', async () => {
    const dbPath = await createStore('page-bounds');
    for (const effect of [
      queryLatestPullRequestObservations({
        dbPath,
        batch: Array.from({ length: MAX_WORK_THREAD_FACT_KEYS + 1 }, () => pullRequest()),
      }),
      queryLatestJiraIssueObservations({
        dbPath,
        batch: Array.from({ length: MAX_WORK_THREAD_FACT_KEYS + 1 }, () => jiraIssue()),
      }),
      queryLatestCheckoutStatusObservations({
        dbPath,
        batch: Array.from({ length: MAX_WORK_THREAD_CHECKOUT_KEYS + 1 }, () => ({
          machineId: 'machine-a',
          checkoutPath: '/checkout',
        })),
      }),
      queryLatestPullRequestObservations({ dbPath, batch: [pullRequest({ machineId: '' })] }),
      queryLatestPullRequestObservations({ dbPath, batch: [pullRequest({ number: 0 })] }),
      queryLatestJiraIssueObservations({ dbPath, batch: [{ machineId: 'machine-a', key: 'bad-key' }] }),
      queryLatestCheckoutStatusObservations({ dbPath, batch: [{ machineId: 'machine-a', checkoutPath: '' }] }),
      queryLatestPullRequestObservations({ dbPath, limit: 501 }),
      queryLatestJiraIssueObservations({ dbPath, limit: 501 }),
      queryLatestCheckoutStatusObservations({ dbPath, limit: 501 }),
    ]) {
      expect(await failureReason(effect)).toBe('invalid-input');
    }
  });

  test('reports invalid stored observations in an exact batch', async () => {
    const dbPath = await createStore('page-invalid-history');
    await Effect.runPromise(importJiraIssueObservations({ dbPath, observations: [jiraIssue()] }));
    const db = new Database(dbPath);
    db.exec("UPDATE jira_issue_observations SET comments_json = 'invalid-json'");
    db.close();
    expect(await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath, batch: [jiraIssue()] }))).toEqual({
      items: [],
      skipped: 1,
      truncated: false,
    });
  });
});
