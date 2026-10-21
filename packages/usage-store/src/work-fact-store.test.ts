import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import {
  queryLatestCheckoutStatusObservations,
  queryLatestPullRequestObservations,
  queryUsageStoreGeneration,
  queryWorkFactRunStates,
  type UsageStoreError,
} from './reader';
import {
  importCheckoutStatusObservations,
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
    draft: false,
    headRef: 'feat/work-view',
    host: 'github.com',
    machineId: 'machine-a',
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
  const result = await Effect.runPromise(Effect.either(effect));
  return result._tag === 'Left' ? result.left.reason : undefined;
};

describe('work fact store: pull request observations', () => {
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
      { latest: failedCheckout(2), latestObserved: checkout() },
      { latest: other, latestObserved: other },
    ]);
    const filtered = await Effect.runPromise(
      queryLatestCheckoutStatusObservations({ dbPath, paths: ['/home/alex/projects/other'] }),
    );
    expect(filtered.items).toEqual([{ latest: other, latestObserved: other }]);
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
    expect(latest.items).toEqual([{ latest: failedCheckout(6), latestObserved: checkout() }]);
    await Effect.runPromise(
      importCheckoutStatusObservations({ dbPath, observations: [checkout({ observedAt: at(7) })] }),
    );
    expect(rowCount(dbPath, 'checkout_status_observations')).toBe(5);
  });
});

describe('work fact store: run state', () => {
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
          ranAt: at(0),
          sourceId: 'checkouts.status',
        },
        {
          disabled: true,
          failed: 0,
          machineId: 'machine-a',
          message: 'github.enabled is false in the local config',
          observed: 0,
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
