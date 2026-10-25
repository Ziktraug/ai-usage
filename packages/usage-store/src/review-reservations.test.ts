import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FrozenDelegationScope } from '@ai-usage/report-core/delegation-contracts';
import type { ReviewAttemptTarget } from '@ai-usage/report-core/work-attempts';
import type { ExecutorDeclaration } from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { NewDelegationJob } from './delegation-store';
import type { UsageStoreError } from './errors';
import { queryReviewReservations } from './reader';
import type { NewReviewAttempt } from './review-attempt-store';
import {
  checkReviewReservations,
  countReviewReservationsByPool,
  type ReviewReservationHolder,
  reviewTargetReservationHolder,
} from './review-reservations';
import {
  initializeUsageStore,
  markDelegationJobsLost,
  markReviewAttemptsLost,
  releaseDelegationJobReservation,
  releaseReviewAttemptReservation,
  requestDelegationJob,
  requestReviewAttempt,
  transitionReviewAttempt,
} from './writer';

/**
 * One reservation rule for both review families (PR #73 F1): a legacy review attempt and a
 * delegation job count against the same target and the same pool, inside each family's own insert
 * transaction, on a real disposable store. Pre-upgrade legacy rows (no frozen revision, no
 * parseable declaration) are read as the uncertainty they are and said so, never ignored.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-shared';
const NOW = '2026-10-25T10:00:00.000Z';
const CHECKOUT = '/home/fixture/work/project';
const POOL = `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`;
const OTHER_POOL = `declared:${JSON.stringify([MACHINE, 'claude-code', 'work'])}`;
const CODEX_POOL = `declared:${JSON.stringify([MACHINE, 'codex', 'work'])}`;
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);

const declaration: ExecutorDeclaration = {
  accountScope: 'personal',
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  effort: null,
  harness: 'claude-code',
  machineId: MACHINE,
  model: null,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
};

const target: ReviewAttemptTarget = {
  checkoutOrigin: 'desktop-cwd',
  checkoutPath: CHECKOUT,
  desktopSessionId: 'local_one',
  harness: 'claude',
  projectLabel: 'project',
  sessionTitle: 'Fixture',
  sourceSessionId: 'cli-1',
};

const scope: FrozenDelegationScope = {
  base: 'first-parent',
  baseRef: null,
  baseSha: BASE,
  commitCount: 1,
  headRef: 'HEAD',
  headSha: HEAD,
  kind: 'commit',
};

const newAttempt = (overrides: Partial<NewReviewAttempt> = {}): NewReviewAttempt => ({
  candidateId: POOL,
  declaration,
  executorHarness: 'claude-code',
  idempotencyKey: `legacy-${overrides.attemptId ?? 'x'}`.padEnd(64, 'k'),
  launchSessionId: '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  machineId: MACHINE,
  requestedAt: NOW,
  reservation: { baseSha: BASE, headSha: HEAD, maxConcurrent: 1, poolId: POOL },
  state: 'requested',
  target,
  ...overrides,
});

const newJob = (overrides: Partial<NewDelegationJob> = {}): NewDelegationJob => ({
  accountScope: 'personal',
  action: 'read-only-review',
  checkoutPath: CHECKOUT,
  context: 'personal',
  effort: null,
  executorHarness: 'claude-code',
  idempotencyKey: `caller:${overrides.jobId ?? 'x'}`,
  launchMarker: '2f6a0c4e-5d7b-4a9c-8e1f-2b3c4d5e6f70',
  machineId: MACHINE,
  modelRequested: null,
  poolId: POOL,
  qualification: null,
  qualificationId: null,
  request: {
    action: 'read-only-review',
    checkout: { path: CHECKOUT },
    constraints: [],
    criteria: [],
    objective: 'Review it.',
    schemaVersion: 1,
    scope: { commit: HEAD, kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestDigest: 'd'.repeat(64),
  requestedAt: NOW,
  retryOf: null,
  routeId: POOL,
  scope,
  selection: null,
  selectionDigest: null,
  state: 'requested',
  taskCategory: 'correctness',
  ...overrides,
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-review-reservations-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const run = <Value>(effect: Effect.Effect<Value, UsageStoreError>): Promise<Value> => Effect.runPromise(effect);

const requestJob = (dbPath: string, overrides: Partial<NewDelegationJob> = {}, maxConcurrent = 1) =>
  run(requestDelegationJob({ dbPath, job: newJob(overrides), limits: { maxAttempts: 1, maxConcurrent } }));

const holders = async (dbPath: string): Promise<readonly ReviewReservationHolder[]> =>
  (await run(queryReviewReservations({ dbPath, machineId: MACHINE }))).holders;

/** A review attempt row as an engine from before the frozen-revision columns could have left it. */
const insertPreUpgradeAttempt = (
  dbPath: string,
  input: {
    readonly attemptId: string;
    readonly checkoutPath: string | null;
    readonly declarationJson: string | null;
    readonly scopeJson?: string | null;
    readonly state?: string;
  },
): void => {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id,
        checkout_path, candidate_id, executor_harness, declaration_json, scope_json, state, requested_at, updated_at)
      VALUES (?, ?, ?, 'read-only-review', 'claude', 'cli-old', ?, ?, 'claude-code', ?, ?, ?, ?, ?)
    `).run(
      input.attemptId,
      MACHINE,
      `old-${input.attemptId}`.padEnd(64, 'o'),
      input.checkoutPath,
      POOL,
      input.declarationJson,
      input.scopeJson ?? null,
      input.state ?? 'running',
      NOW,
      NOW,
    );
  } finally {
    db.close();
  }
};

describe('shared review reservations', () => {
  test('a legacy attempt and a delegation job reserve one target and one pool together, in both insert orders', async () => {
    const dbPath = await createStore();
    // Legacy first: the delegation on the same frozen target is refused, then another target on the pool.
    const legacy = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'legacy-1' }), dbPath }));
    expect(legacy).toMatchObject({ kind: 'inserted', reused: false });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query('SELECT base_sha, head_sha FROM review_attempts WHERE attempt_id = ?').get('legacy-1')).toEqual({
        base_sha: BASE,
        head_sha: HEAD,
      });
    } finally {
      db.close();
    }
    const sameTarget = await requestJob(dbPath, { jobId: 'job-1' });
    expect(sameTarget).toMatchObject({
      existing: { jobId: 'legacy-1', state: 'requested' },
      holder: { family: 'review-attempt', id: 'legacy-1', poolId: POOL },
      kind: 'target-reserved',
      message:
        'review attempt legacy-1 (requested) already reserves this review (same action, checkout and frozen revision); follow it instead of starting another.',
    });
    const samePool = await requestJob(dbPath, { jobId: 'job-2', scope: { ...scope, headSha: OTHER_HEAD } });
    expect(samePool).toMatchObject({
      count: 1,
      holders: [{ family: 'review-attempt', id: 'legacy-1' }],
      kind: 'pool-busy',
      message: `Pool ${POOL} runs 1 reserving job(s) or attempt(s): review attempt legacy-1 (requested); the limit is 1.`,
    });
    // Another pool of the same harness is free; a wider limit admits the same pool.
    expect(
      await requestJob(dbPath, { jobId: 'job-3', poolId: OTHER_POOL, scope: { ...scope, headSha: OTHER_HEAD } }),
    ).toMatchObject({
      kind: 'inserted',
    });
    expect(await requestJob(dbPath, { jobId: 'job-4', scope: { ...scope, headSha: 'e'.repeat(40) } }, 2)).toMatchObject(
      {
        kind: 'inserted',
      },
    );

    // Delegation first on a fresh store: the legacy attempt is refused on the target, then on the pool.
    const other = await createStore();
    expect(await requestJob(other, { jobId: 'job-1' })).toMatchObject({ kind: 'inserted' });
    const legacySameTarget = await run(
      requestReviewAttempt({ attempt: newAttempt({ attemptId: 'legacy-1' }), dbPath: other }),
    );
    expect(legacySameTarget).toMatchObject({
      holder: { family: 'delegation', id: 'job-1' },
      kind: 'target-reserved',
      message:
        'delegation job job-1 (requested) already reserves this review (same action, checkout and frozen revision); follow it instead of starting another.',
    });
    const legacySamePool = await run(
      requestReviewAttempt({
        attempt: newAttempt({
          attemptId: 'legacy-2',
          reservation: { baseSha: BASE, headSha: OTHER_HEAD, maxConcurrent: 1, poolId: POOL },
        }),
        dbPath: other,
      }),
    );
    expect(legacySamePool).toMatchObject({
      count: 1,
      kind: 'pool-busy',
      message: `Pool ${POOL} runs 1 reserving job(s) or attempt(s): delegation job job-1 (requested); the limit is 1.`,
    });
    // Nothing was inserted for the refusals.
    expect((await holders(other)).map((holder) => holder.id)).toEqual(['job-1']);
    // A wider limit admits the legacy attempt beside the job.
    expect(
      await run(
        requestReviewAttempt({
          attempt: newAttempt({
            attemptId: 'legacy-2',
            reservation: { baseSha: BASE, headSha: OTHER_HEAD, maxConcurrent: 2, poolId: POOL },
          }),
          dbPath: other,
        }),
      ),
    ).toMatchObject({ kind: 'inserted' });
  });

  test('a lost row of either family keeps its reservation until its own evidence releases it; nothing by age', async () => {
    const dbPath = await createStore();
    await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'legacy-1' }), dbPath }));
    await run(
      transitionReviewAttempt({ at: NOW, attemptId: 'legacy-1', dbPath, patch: { pid: 4242, state: 'running' } }),
    );
    await run(markReviewAttemptsLost({ at: NOW, dbPath, machineId: MACHINE, reason: () => 'restarted' }));
    expect(await holders(dbPath)).toMatchObject([{ family: 'review-attempt', id: 'legacy-1', state: 'lost' }]);
    expect(await requestJob(dbPath, { jobId: 'job-1', scope: { ...scope, headSha: OTHER_HEAD } })).toMatchObject({
      kind: 'pool-busy',
      message: expect.stringContaining('review attempt legacy-1 (lost)'),
    });
    await run(releaseReviewAttemptReservation({ at: NOW, attemptId: 'legacy-1', dbPath, evidence: 'process-absent' }));
    expect(await holders(dbPath)).toEqual([]);
    expect(await requestJob(dbPath, { jobId: 'job-1', scope: { ...scope, headSha: OTHER_HEAD } })).toMatchObject({
      kind: 'inserted',
    });

    await run(markDelegationJobsLost({ at: NOW, dbPath, machineId: MACHINE, reason: 'restarted' }));
    expect(await holders(dbPath)).toMatchObject([{ family: 'delegation', id: 'job-1', state: 'lost' }]);
    expect(await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'legacy-2' }), dbPath }))).toMatchObject({
      kind: 'pool-busy',
      message: expect.stringContaining('delegation job job-1 (lost)'),
    });
    await run(releaseDelegationJobReservation({ at: NOW, dbPath, evidence: 'process-absent', jobId: 'job-1' }));
    expect(await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'legacy-2' }), dbPath }))).toMatchObject({
      kind: 'inserted',
    });
  });

  test('a pre-upgrade legacy row reserves what it recorded: its scope, else its checkout, else the machine; an unreadable pool counts everywhere', async () => {
    const dbPath = await createStore();
    // Recorded scope but no frozen columns: the revision the scope names.
    insertPreUpgradeAttempt(dbPath, {
      attemptId: 'old-scope',
      checkoutPath: CHECKOUT,
      declarationJson: JSON.stringify(declaration),
      scopeJson: JSON.stringify({ baseSha: BASE, headSha: HEAD }),
    });
    expect(await holders(dbPath)).toMatchObject([
      {
        id: 'old-scope',
        poolId: POOL,
        scope: { baseSha: BASE, checkoutPath: CHECKOUT, headSha: HEAD, kind: 'revision', provenance: 'recorded-scope' },
      },
    ]);
    const reserved = await requestJob(dbPath, { jobId: 'job-1' });
    expect(reserved).toMatchObject({ kind: 'target-reserved' });
    expect(reserved.kind === 'target-reserved' && reserved.message).toContain(
      'the scope it recorded at launch names the same checkout and revision (its frozen revision was not persisted at request time)',
    );
    // Another revision of the same checkout is free of that row (the pool is wide enough here).
    expect(await requestJob(dbPath, { jobId: 'job-2', scope: { ...scope, headSha: OTHER_HEAD } }, 2)).toMatchObject({
      kind: 'inserted',
    });

    // No scope at all: the whole checkout.
    const second = await createStore();
    insertPreUpgradeAttempt(second, { attemptId: 'old-checkout', checkoutPath: CHECKOUT, declarationJson: null });
    expect(await holders(second)).toMatchObject([
      { id: 'old-checkout', poolId: null, scope: { checkoutPath: CHECKOUT, kind: 'checkout' } },
    ]);
    const wholeCheckout = await requestJob(second, { jobId: 'job-1', scope: { ...scope, headSha: OTHER_HEAD } }, 4);
    expect(wholeCheckout).toMatchObject({ kind: 'target-reserved' });
    expect(wholeCheckout.kind === 'target-reserved' && wholeCheckout.message).toBe(
      `review attempt old-checkout (running) reserves the whole checkout ${CHECKOUT}: it recorded no reviewed revision (a row from before frozen revisions), so every revision of that checkout counts as reserved until it is released with evidence; follow it instead of starting another.`,
    );
    // Another checkout: the target is free, but the unknown pool fills every pool of the harness.
    const unknownPool = await requestJob(second, { checkoutPath: '/elsewhere', jobId: 'job-2', poolId: OTHER_POOL });
    expect(unknownPool).toMatchObject({ count: 1, kind: 'pool-busy' });
    expect(unknownPool.kind === 'pool-busy' && unknownPool.message).toBe(
      `Pool ${OTHER_POOL} runs 1 reserving job(s) or attempt(s): review attempt old-checkout (running) [pool unknown: its declaration is missing or does not parse, so it counts against every claude-code pool on this machine]; the limit is 1.`,
    );
    // Not a Codex pool, though.
    expect(
      await requestJob(second, {
        checkoutPath: '/elsewhere',
        executorHarness: 'codex',
        jobId: 'job-3',
        poolId: CODEX_POOL,
      }),
    ).toMatchObject({ kind: 'inserted' });

    // No checkout either: every target of the machine.
    const third = await createStore();
    insertPreUpgradeAttempt(third, { attemptId: 'old-nothing', checkoutPath: null, declarationJson: 'not json' });
    expect(await holders(third)).toMatchObject([{ id: 'old-nothing', poolId: null, scope: { kind: 'machine' } }]);
    const everything = await requestJob(third, { checkoutPath: '/anywhere', jobId: 'job-1', poolId: OTHER_POOL }, 4);
    expect(everything).toMatchObject({ kind: 'target-reserved' });
    expect(everything.kind === 'target-reserved' && everything.message).toContain(
      'reserves every target of this machine: it recorded neither a checkout nor a reviewed revision',
    );
    const legacyToo = await run(
      requestReviewAttempt({
        attempt: newAttempt({ attemptId: 'legacy-1', target: { ...target, checkoutPath: '/anywhere' } }),
        dbPath: third,
      }),
    );
    expect(legacyToo).toMatchObject({ holder: { id: 'old-nothing' }, kind: 'target-reserved' });
  });

  test('the pure helpers count unknown pools against every pool of the harness and find the earliest holder', () => {
    const known: ReviewReservationHolder = {
      action: 'read-only-review',
      family: 'delegation',
      harness: 'claude-code',
      id: 'job-1',
      poolId: POOL,
      scope: { baseSha: BASE, checkoutPath: CHECKOUT, headSha: HEAD, kind: 'revision', provenance: 'frozen' },
      state: 'running',
    };
    const unknown: ReviewReservationHolder = {
      action: 'read-only-review',
      family: 'review-attempt',
      harness: 'claude-code',
      id: 'old-1',
      poolId: null,
      scope: { checkoutPath: '/elsewhere', kind: 'checkout' },
      state: 'lost',
    };
    const foreign: ReviewReservationHolder = { ...known, id: 'job-9', poolId: 'declared:["other","claude-code","x"]' };
    const counts = countReviewReservationsByPool(
      [known, unknown, foreign],
      [
        { harness: 'claude-code', poolId: POOL },
        { harness: 'claude-code', poolId: OTHER_POOL },
        { harness: 'codex', poolId: CODEX_POOL },
      ],
    );
    expect([...counts.entries()]).toEqual([
      [POOL, 2],
      [OTHER_POOL, 1],
      [CODEX_POOL, 0],
      ['declared:["other","claude-code","x"]', 1],
    ]);
    const probe = { action: 'read-only-review', baseSha: BASE, checkoutPath: CHECKOUT, headSha: HEAD };
    expect(reviewTargetReservationHolder([unknown, known], probe)?.id).toBe('job-1');
    expect(reviewTargetReservationHolder([unknown], probe)).toBeNull();
    expect(reviewTargetReservationHolder([unknown], { ...probe, checkoutPath: '/elsewhere' })?.id).toBe('old-1');
    expect(reviewTargetReservationHolder([known], { ...probe, action: 'code-change' })).toBeNull();
    expect(
      checkReviewReservations({
        holders: [known],
        maxConcurrent: 1,
        pool: { harness: 'claude-code', poolId: OTHER_POOL },
        target: { ...probe, headSha: OTHER_HEAD },
      }),
    ).toEqual({ kind: 'free' });
  });
});
