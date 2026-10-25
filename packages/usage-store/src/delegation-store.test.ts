import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  DelegationQualification,
  DelegationReviewResult,
  FrozenDelegationScope,
} from '@ai-usage/report-core/delegation-contracts';
import { Effect } from 'effect';
import { DELEGATION_STORE_BOUNDS, type NewDelegationJob } from './delegation-store';
import type { UsageStoreError } from './errors';
import {
  queryDelegationEvaluations,
  queryDelegationJobs,
  readDelegationJob,
  readDelegationJobs,
  readDelegationQualification,
} from './reader';
import {
  countDelegationRetryChain,
  initializeUsageStore,
  markDelegationJobsLost,
  recordDelegationEvaluation,
  recordDelegationQualification,
  releaseDelegationJobReservation,
  requestDelegationCancel,
  requestDelegationJob,
  transitionDelegationJob,
} from './writer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-delegation';
const NOW = '2026-10-25T10:00:00.000Z';
const LATER = '2026-10-25T10:05:00.000Z';
const END = '2026-10-25T10:10:00.000Z';
const CHECKOUT = '/home/fixture/work/project';
const POOL = `${MACHINE}/claude-code/personal`;
const QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';

const scope: FrozenDelegationScope = {
  base: 'first-parent',
  baseRef: null,
  baseSha: 'b'.repeat(40),
  commitCount: 1,
  headRef: 'HEAD',
  headSha: 'a'.repeat(40),
  kind: 'commit',
};

const qualification = (overrides: Partial<DelegationQualification> = {}): DelegationQualification => ({
  admissibleRouteIds: ['route-a'],
  appliedRules: [],
  assumptions: [],
  checkout: { admittedBy: '/home/fixture/work', path: CHECKOUT, projectLabel: 'project' },
  checkoutFacts: null,
  omittedRoutes: 0,
  outcome: 'routes-available',
  purpose: 'delegation',
  qualificationId: QUALIFICATION_ID,
  qualifiedAt: NOW,
  refusal: null,
  request: { action: 'read-only-review', digest: 'd'.repeat(64), taskCategory: 'correctness' },
  routes: [],
  schemaVersion: 1,
  scope,
  validUntil: LATER,
  versions: {
    catalogRevision: 'cat0123456789abc',
    policyRevision: 'pol0123456789abc',
    qualifier: 'delegation-qualifier/1',
    selectorContract: 'delegation-selection/1',
  },
  ...overrides,
});

const review: DelegationReviewResult = {
  checks: ['read the patch'],
  coverage: { notReviewed: [], reviewed: 'Everything.' },
  findings: [],
  limits: [],
  summary: 'Looks correct.',
};

const newJob = (overrides: Partial<NewDelegationJob> = {}): NewDelegationJob => ({
  accountScope: 'personal',
  action: 'read-only-review',
  checkoutPath: CHECKOUT,
  context: 'personal',
  effort: 'high',
  executorHarness: 'claude-code',
  idempotencyKey: 'caller:session-1:review-7',
  launchMarker: '2f6a0c4e-5d7b-4a9c-8e1f-2b3c4d5e6f70',
  machineId: MACHINE,
  modelRequested: 'claude-opus-4-1',
  poolId: POOL,
  qualification: qualification(),
  qualificationId: QUALIFICATION_ID,
  request: {
    action: 'read-only-review',
    checkout: { path: CHECKOUT },
    constraints: [],
    criteria: ['Every public function keeps its contract.'],
    objective: 'Review the lock refactor for correctness.',
    schemaVersion: 1,
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestDigest: 'd'.repeat(64),
  requestedAt: NOW,
  retryOf: null,
  routeId: 'route-a',
  scope,
  selection: {
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    routeId: 'route-a',
    selectorVersion: 'calling-model/claude-code',
  },
  selectionDigest: 's'.repeat(64),
  state: 'requested',
  taskCategory: 'correctness',
  ...overrides,
});

const limits = { maxAttempts: 2, maxConcurrent: 1 } as const;

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-delegation-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const run = <Value>(effect: Effect.Effect<Value, UsageStoreError>): Promise<Value> => Effect.runPromise(effect);

const request = (dbPath: string, overrides: Partial<NewDelegationJob> = {}) =>
  run(requestDelegationJob({ dbPath, job: newJob(overrides), limits }));

const finish = (dbPath: string, jobId: string, at = END) =>
  run(
    transitionDelegationJob({
      at,
      dbPath,
      jobId,
      patch: { endedAt: at, exitCode: 0, result: { excerpt: null, kind: 'review', review }, state: 'finished' },
    }),
  );

describe('delegation store schema', () => {
  test('creates the three additive tables and their indexes on open without touching user_version', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
      const tables = (
        db
          .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'delegation_%' ORDER BY name")
          .all() as { name: string }[]
      ).map(({ name }) => name);
      expect(tables).toEqual(['delegation_evaluations', 'delegation_jobs', 'delegation_qualifications']);
      const indexes = (
        db
          .query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'delegation_jobs' ORDER BY name")
          .all() as { name: string }[]
      )
        .map(({ name }) => name)
        .filter((name) => !name.startsWith('sqlite_autoindex'));
      expect(indexes).toEqual([
        'idx_delegation_jobs_machine_state',
        'idx_delegation_jobs_pool',
        'idx_delegation_jobs_reserved_target',
        'idx_delegation_jobs_retry_of',
        'idx_delegation_jobs_target',
      ]);
    } finally {
      db.close();
    }
  });

  test('adds the tables to an existing v4 store that lacks them, idempotently and without moving the generation', async () => {
    const dbPath = await createStore();
    const before = new Database(dbPath);
    const generationBefore = before.query("SELECT value FROM usage_store_metadata WHERE key = 'generation'").get();
    before.exec('DROP TABLE delegation_jobs; DROP TABLE delegation_evaluations; DROP TABLE delegation_qualifications;');
    before.close();
    await run(initializeUsageStore({ dbPath }));
    await run(initializeUsageStore({ dbPath }));
    const after = new Database(dbPath, { readonly: true });
    try {
      expect(after.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
      expect(after.query("SELECT value FROM usage_store_metadata WHERE key = 'generation'").get()).toEqual(
        generationBefore,
      );
      expect(
        (
          after
            .query("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name LIKE 'delegation_%'")
            .get() as {
            count: number;
          }
        ).count,
      ).toBe(3);
    } finally {
      after.close();
    }
    expect(await run(queryDelegationJobs({ dbPath }))).toEqual({ jobs: [], skipped: 0, truncated: false });
  });

  test('a store the engine has not upgraded answers a typed schema-too-old, and the edge read says not upgraded', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath);
    db.exec('DROP TABLE delegation_jobs');
    db.close();
    const error = await Effect.runPromise(Effect.flip(queryDelegationJobs({ dbPath })));
    expect(error).toMatchObject({ reason: 'schema-too-old' });
    expect(error.message).toContain('delegation_jobs');
    expect(await Effect.runPromise(readDelegationJobs({ dbPath }))).toMatchObject({ kind: 'store-not-upgraded' });
  });
});

describe('requestDelegationJob', () => {
  test('inserts a requested job, re-reads it through the shared parser, and reuses it on the same key and digests', async () => {
    const dbPath = await createStore();
    const first = await request(dbPath, { jobId: 'job-1' });
    expect(first.kind).toBe('inserted');
    if (first.kind !== 'inserted') {
      throw new Error('expected inserted');
    }
    expect(first.job).toMatchObject({
      attemptNumber: 1,
      checkoutPath: CHECKOUT,
      jobId: 'job-1',
      poolId: POOL,
      qualification: { qualificationId: QUALIFICATION_ID },
      releasedAt: null,
      scope,
      selection: { kind: 'choice', routeId: 'route-a' },
      state: 'requested',
      traceVersion: 1,
    });
    const again = await request(dbPath, { jobId: 'job-2' });
    expect(again).toMatchObject({ job: { jobId: 'job-1' }, kind: 'reused' });
    // The same key with another request or selection is a conflict, and inserts nothing.
    expect(await request(dbPath, { jobId: 'job-3', requestDigest: 'e'.repeat(64) })).toEqual({
      existing: { jobId: 'job-1', state: 'requested' },
      kind: 'idempotency-conflict',
    });
    expect(await request(dbPath, { jobId: 'job-4', selectionDigest: 't'.repeat(64) })).toEqual({
      existing: { jobId: 'job-1', state: 'requested' },
      kind: 'idempotency-conflict',
    });
    expect((await run(queryDelegationJobs({ dbPath }))).jobs.map(({ jobId }) => jobId)).toEqual(['job-1']);
  });

  test('reserves one target per machine and bounds the pool; refusals and abstentions are recorded without those checks', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-1' });
    // Another key on the same frozen target is refused by the reservation.
    expect(await request(dbPath, { idempotencyKey: 'caller:session-2:review-1', jobId: 'job-2' })).toEqual({
      existing: { jobId: 'job-1', state: 'requested' },
      kind: 'target-reserved',
    });
    // Another target in the same pool is refused by the concurrency limit.
    const otherScope = { ...scope, headSha: 'c'.repeat(40) };
    expect(
      await request(dbPath, { idempotencyKey: 'caller:session-2:review-2', jobId: 'job-3', scope: otherScope }),
    ).toEqual({ count: 1, kind: 'pool-busy' });
    // A larger pool limit admits it.
    expect(
      await run(
        requestDelegationJob({
          dbPath,
          job: newJob({ idempotencyKey: 'caller:session-2:review-2', jobId: 'job-3', scope: otherScope }),
          limits: { maxAttempts: 2, maxConcurrent: 2 },
        }),
      ),
    ).toMatchObject({ kind: 'inserted' });
    // Refusals and abstentions are decisions, recorded beside the live rows and never reserving.
    const refused = await request(dbPath, {
      failureReason: 'pool already runs 1 job',
      idempotencyKey: 'caller:session-3:review-1',
      jobId: 'job-refused',
      poolId: null,
      refusalReason: 'pool-busy',
      routeId: null,
      selection: null,
      selectionDigest: null,
      state: 'refused',
    });
    expect(refused).toMatchObject({ job: { refusalReason: 'pool-busy', state: 'refused' }, kind: 'inserted' });
    const abstained = await request(dbPath, {
      idempotencyKey: 'caller:session-4:review-1',
      jobId: 'job-abstained',
      poolId: null,
      routeId: null,
      selection: {
        kind: 'abstain',
        qualificationId: QUALIFICATION_ID,
        reason: 'keep-with-caller',
        selectorVersion: 'calling-model/claude-code',
      },
      state: 'abstained',
    });
    expect(abstained).toMatchObject({ job: { state: 'abstained' }, kind: 'inserted' });
    const reserving = await run(queryDelegationJobs({ dbPath, reserving: true }));
    expect(reserving.jobs.map(({ jobId }) => jobId).sort()).toEqual(['job-1', 'job-3']);
    // Once the jobs end, the target and the pool are free again.
    await finish(dbPath, 'job-1');
    await finish(dbPath, 'job-3');
    expect(await request(dbPath, { idempotencyKey: 'caller:session-2:review-1', jobId: 'job-5' })).toMatchObject({
      job: { jobId: 'job-5' },
      kind: 'inserted',
    });
    // The unique index enforces the reservation below the code path too.
    const raw = new Database(dbPath);
    try {
      expect(() =>
        raw
          .query(`
            INSERT INTO delegation_jobs (job_id, machine_id, idempotency_key, request_digest, request_json, action, task_category,
              checkout_path, base_sha, head_sha, attempt_number, state, requested_at, updated_at, trace_version)
            VALUES ('twin', '${MACHINE}', 'twin-key-1', 'x', '{}', 'read-only-review', 'correctness', '${CHECKOUT}',
              '${'b'.repeat(40)}', '${'a'.repeat(40)}', 1, 'requested', '${NOW}', '${NOW}', 1)
          `)
          .run(),
      ).toThrow('UNIQUE');
    } finally {
      raw.close();
    }
  });

  test('requires a frozen scope, a checkout, a route and a pool for a requested job', async () => {
    const dbPath = await createStore();
    await expect(request(dbPath, { scope: null })).rejects.toMatchObject({ reason: 'invalid-input' });
    await expect(request(dbPath, { checkoutPath: null })).rejects.toMatchObject({ reason: 'invalid-input' });
    await expect(request(dbPath, { poolId: null })).rejects.toMatchObject({ reason: 'invalid-input' });
    await expect(request(dbPath, { retryOf: 'unknown-job' })).rejects.toMatchObject({ reason: 'invalid-input' });
    await expect(
      run(requestDelegationJob({ dbPath, job: newJob(), limits: { maxAttempts: 0, maxConcurrent: 1 } })),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    expect(await run(queryDelegationJobs({ dbPath }))).toEqual({ jobs: [], skipped: 0, truncated: false });
  });

  test('counts the retry chain: attempt numbers follow the links and the limit stops the chain', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-1' });
    await run(
      transitionDelegationJob({ at: LATER, dbPath, jobId: 'job-1', patch: { endedAt: LATER, state: 'failed' } }),
    );
    const second = await request(dbPath, {
      idempotencyKey: 'caller:session-1:review-8',
      jobId: 'job-2',
      retryOf: 'job-1',
    });
    expect(second).toMatchObject({ job: { attemptNumber: 2, retryOf: 'job-1' }, kind: 'inserted' });
    await run(transitionDelegationJob({ at: END, dbPath, jobId: 'job-2', patch: { endedAt: END, state: 'failed' } }));
    // Two attempts ran: a third is refused whether it names the last job or the first.
    expect(
      await request(dbPath, { idempotencyKey: 'caller:session-1:review-9', jobId: 'job-3', retryOf: 'job-2' }),
    ).toEqual({ count: 2, kind: 'attempts-exhausted' });
    expect(
      await request(dbPath, { idempotencyKey: 'caller:session-1:review-10', jobId: 'job-4', retryOf: 'job-1' }),
    ).toEqual({ count: 2, kind: 'attempts-exhausted' });
    // A refused row in the chain is a decision, not an attempt.
    await request(dbPath, {
      failureReason: 'attempts exhausted',
      idempotencyKey: 'caller:session-1:review-9',
      jobId: 'job-3-refused',
      poolId: null,
      refusalReason: 'attempts-exhausted',
      retryOf: 'job-2',
      routeId: null,
      state: 'refused',
    });
    expect(
      await run(
        requestDelegationJob({
          dbPath,
          job: newJob({ idempotencyKey: 'caller:session-1:review-11', jobId: 'job-5', retryOf: 'job-2' }),
          limits: { maxAttempts: 3, maxConcurrent: 1 },
        }),
      ),
    ).toMatchObject({ job: { attemptNumber: 3 }, kind: 'inserted' });
    // The read-only count answers what the transaction would count, from any link of the chain.
    expect(await run(countDelegationRetryChain({ dbPath, retryOf: 'job-5' }))).toEqual({
      ancestors: 3,
      attempts: 3,
      parentKnown: true,
    });
    expect(await run(countDelegationRetryChain({ dbPath, retryOf: 'job-1' }))).toEqual({
      ancestors: 1,
      attempts: 3,
      parentKnown: true,
    });
    expect(await run(countDelegationRetryChain({ dbPath, retryOf: 'job-3-refused' }))).toEqual({
      ancestors: 3,
      attempts: 3,
      parentKnown: true,
    });
    expect(await run(countDelegationRetryChain({ dbPath, retryOf: 'nope' }))).toEqual({
      ancestors: 0,
      attempts: 0,
      parentKnown: false,
    });
  });

  test('two connections racing on one target or one pool never both reserve', async () => {
    const dbPath = await createStore();
    const sameTarget = await Promise.all([
      request(dbPath, { idempotencyKey: 'caller:a:review-1', jobId: 'race-a' }),
      request(dbPath, { idempotencyKey: 'caller:b:review-1', jobId: 'race-b' }),
    ]);
    expect(sameTarget.filter((result) => result.kind === 'inserted')).toHaveLength(1);
    expect(sameTarget.filter((result) => result.kind === 'target-reserved')).toHaveLength(1);
    const otherDb = await createStore();
    const samePool = await Promise.all(
      ['c', 'd', 'e'].map((suffix) =>
        request(otherDb, {
          idempotencyKey: `caller:${suffix}:review-1`,
          jobId: `pool-${suffix}`,
          scope: { ...scope, headSha: suffix.repeat(40) },
        }),
      ),
    );
    expect(samePool.filter((result) => result.kind === 'inserted')).toHaveLength(1);
    expect(samePool.filter((result) => result.kind === 'pool-busy')).toHaveLength(2);
    expect((await run(queryDelegationJobs({ dbPath: otherDb, reserving: true }))).jobs).toHaveLength(1);
  });
});

describe('transitions, cancellation, loss and release', () => {
  test('guards transitions by state, records every mutable column, and ignores late writes after the end', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-1' });
    expect(
      await run(
        transitionDelegationJob({
          at: LATER,
          dbPath,
          jobId: 'job-1',
          patch: {
            guarantee: {
              cliVersion: '2.1.303',
              controls: ['tools Read Grep Glob'],
              effort: 'high',
              harness: 'claude-code',
              limits: [],
              model: 'claude-opus-4-1',
            },
            harnessVersion: '2.1.303',
            pid: 4242,
            startedAt: LATER,
            state: 'starting',
          },
        }),
      ),
    ).toEqual({ applied: true });
    expect(
      await run(
        transitionDelegationJob({
          at: LATER,
          dbPath,
          jobId: 'job-1',
          patch: {
            executedScope: {
              fileCount: 1,
              files: [{ coverage: 'complete', path: 'src/lock.ts' }],
              includedBytes: 10,
              patchBytes: 10,
              patchSha256: 'f'.repeat(64),
              truncated: false,
              workingTreeDirty: false,
            },
            modelResolved: 'claude-opus-4-1-20250805',
            nativeSessionId: 'native-1',
            state: 'running',
          },
        }),
      ),
    ).toEqual({ applied: true });
    // No step back once the harness reported running.
    expect(
      await run(
        transitionDelegationJob({
          at: LATER,
          dbPath,
          fromStates: ['requested'],
          jobId: 'job-1',
          patch: { state: 'starting' },
        }),
      ),
    ).toEqual({ applied: false });
    // A heartbeat is an empty patch from a live state.
    expect(await run(transitionDelegationJob({ at: END, dbPath, jobId: 'job-1', patch: {} }))).toEqual({
      applied: true,
    });
    expect(
      await run(
        transitionDelegationJob({
          at: END,
          dbPath,
          jobId: 'job-1',
          patch: {
            endedAt: END,
            exitCode: 0,
            failureReason: null,
            result: { excerpt: 'x'.repeat(10_000), kind: 'unstructured', review: null },
            state: 'finished',
            usage: { cachedInputTokens: 10, inputTokens: 100, outputTokens: 20, source: 'harness-reported' },
          },
        }),
      ),
    ).toEqual({ applied: true });
    // Late writes from the ended process change nothing.
    expect(
      await run(transitionDelegationJob({ at: '2026-10-25T10:11:00.000Z', dbPath, jobId: 'job-1', patch: {} })),
    ).toEqual({
      applied: false,
    });
    expect(
      await run(
        transitionDelegationJob({
          at: '2026-10-25T10:11:00.000Z',
          dbPath,
          jobId: 'job-1',
          patch: { state: 'running' },
        }),
      ),
    ).toEqual({ applied: false });
    expect(await run(transitionDelegationJob({ at: END, dbPath, jobId: 'missing', patch: {} }))).toEqual({
      applied: false,
    });
    const [job] = (await run(queryDelegationJobs({ dbPath }))).jobs;
    expect(job).toMatchObject({
      endedAt: END,
      exitCode: 0,
      guarantee: { cliVersion: '2.1.303', harness: 'claude-code' },
      harnessVersion: '2.1.303',
      modelResolved: 'claude-opus-4-1-20250805',
      nativeSessionId: 'native-1',
      pid: 4242,
      result: { kind: 'unstructured', review: null },
      startedAt: LATER,
      state: 'finished',
      updatedAt: END,
      usage: { inputTokens: 100, source: 'harness-reported' },
    });
    expect(job?.executedScope?.files).toEqual([{ coverage: 'complete', path: 'src/lock.ts' }]);
    expect(job?.result?.excerpt?.length).toBe(4000);
  });

  test('cancellation is requested on a live row only, once', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-1' });
    expect(await run(requestDelegationCancel({ at: LATER, dbPath, jobId: 'job-1' }))).toEqual({
      applied: true,
      state: 'requested',
    });
    expect(await run(requestDelegationCancel({ at: END, dbPath, jobId: 'job-1' }))).toEqual({
      applied: true,
      state: 'requested',
    });
    expect((await run(queryDelegationJobs({ dbPath }))).jobs[0]?.cancelRequestedAt).toBe(LATER);
    await run(
      transitionDelegationJob({ at: END, dbPath, jobId: 'job-1', patch: { endedAt: END, state: 'cancelled' } }),
    );
    expect(await run(requestDelegationCancel({ at: END, dbPath, jobId: 'job-1' }))).toEqual({
      applied: false,
      state: 'cancelled',
    });
    expect(await run(requestDelegationCancel({ at: END, dbPath, jobId: 'missing' }))).toEqual({
      applied: false,
      state: null,
    });
  });

  test('a lost job keeps its reservation until release evidence; a late outcome is recorded without resurrecting it', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-1' });
    await run(transitionDelegationJob({ at: LATER, dbPath, jobId: 'job-1', patch: { pid: 77, state: 'running' } }));
    await request(dbPath, { idempotencyKey: 'caller:other:review-1', jobId: 'other-machine', machineId: 'elsewhere' });
    const lost = await run(
      markDelegationJobsLost({
        at: END,
        dbPath,
        machineId: MACHINE,
        reason: ({ pid, state }) => `engine restarted while ${state}${pid === null ? '' : ` (pid ${pid})`}`,
      }),
    );
    expect(lost).toEqual({ lost: ['job-1'] });
    const [job] = (await run(queryDelegationJobs({ dbPath, machineId: MACHINE }))).jobs;
    expect(job).toMatchObject({
      endedAt: END,
      failureReason: 'engine restarted while running (pid 77)',
      releasedAt: null,
      state: 'lost',
    });
    expect((await run(queryDelegationJobs({ dbPath, machineId: 'elsewhere' }))).jobs[0]?.state).toBe('requested');
    // Still reserving: the same target is refused, a heartbeat is ignored, a cancel is refused.
    expect(await request(dbPath, { idempotencyKey: 'caller:b:review-1', jobId: 'job-2' })).toEqual({
      existing: { jobId: 'job-1', state: 'lost' },
      kind: 'target-reserved',
    });
    expect(await run(transitionDelegationJob({ at: END, dbPath, jobId: 'job-1', patch: {} }))).toEqual({
      applied: false,
    });
    expect(await run(requestDelegationCancel({ at: END, dbPath, jobId: 'job-1' }))).toEqual({
      applied: false,
      state: 'lost',
    });
    // Release only from `lost`.
    expect(
      await run(
        releaseDelegationJobReservation({ at: END, dbPath, evidence: 'process-absent', jobId: 'other-machine' }),
      ),
    ).toEqual({ applied: false });
    expect(
      await run(
        releaseDelegationJobReservation({
          at: '2026-10-25T10:12:00.000Z',
          dbPath,
          evidence: 'outcome-recorded-late',
          jobId: 'job-1',
          outcome: { exitCode: 0, result: { excerpt: null, kind: 'review', review } },
        }),
      ),
    ).toEqual({ applied: true });
    // The first evidence stands.
    await run(
      releaseDelegationJobReservation({
        at: '2026-10-25T10:13:00.000Z',
        dbPath,
        evidence: 'process-absent',
        jobId: 'job-1',
      }),
    );
    const [released] = (await run(queryDelegationJobs({ dbPath, states: ['lost'] }))).jobs;
    expect(released).toMatchObject({
      exitCode: 0,
      releaseEvidence: 'outcome-recorded-late',
      releasedAt: '2026-10-25T10:12:00.000Z',
      result: { kind: 'review', review: { summary: 'Looks correct.' } },
      state: 'lost',
    });
    expect((await run(queryDelegationJobs({ dbPath, machineId: MACHINE, reserving: true }))).jobs).toEqual([]);
    expect(await request(dbPath, { idempotencyKey: 'caller:b:review-1', jobId: 'job-2' })).toMatchObject({
      job: { jobId: 'job-2' },
      kind: 'inserted',
    });
  });
});

describe('evaluations', () => {
  const evaluation = (jobId: string, overrides: Record<string, unknown> = {}) => ({
    author: 'calling-model' as const,
    authorLabel: 'claude-code',
    checks: ['bun test'],
    jobId,
    kind: 'verification' as const,
    note: 'Confirmed by re-reading the file.',
    recordedAt: END,
    verdict: 'confirmed' as const,
    ...overrides,
  });

  test('an acceptance needs an ended job and a verification a finished one; both are append-only', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-1' });
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-1', { author: 'operator', kind: 'acceptance', verdict: 'accepted' }),
        }),
      ),
    ).toEqual({ kind: 'job-not-ended', state: 'requested' });
    expect(await run(recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-1') }))).toEqual({
      kind: 'job-not-finished',
      state: 'requested',
    });
    expect(await run(recordDelegationEvaluation({ dbPath, evaluation: evaluation('missing') }))).toEqual({
      kind: 'job-not-found',
    });
    await run(
      transitionDelegationJob({ at: LATER, dbPath, jobId: 'job-1', patch: { endedAt: LATER, state: 'failed' } }),
    );
    // Failed: an acceptance (taken over) may be recorded, a model's verification may not; the
    // engine's own structural check may, inconclusively.
    expect(await run(recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-1') }))).toEqual({
      kind: 'job-not-finished',
      state: 'failed',
    });
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-1', {
            author: 'automated-check',
            authorLabel: 'engine',
            evaluationId: 'check-1',
            verdict: 'inconclusive',
          }),
        }),
      ),
    ).toEqual({ evaluationId: 'check-1', kind: 'recorded' });
    // The engine's check still needs an ended job.
    await request(dbPath, {
      idempotencyKey: 'caller:session-1:review-live',
      jobId: 'job-live',
      scope: { ...scope, headSha: 'f'.repeat(40) },
    });
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-live', { author: 'automated-check', verdict: 'inconclusive' }),
        }),
      ),
    ).toEqual({ kind: 'job-not-finished', state: 'requested' });
    // Cancelled: the engine's check is recorded (inconclusive); the pool is free again for job-2 below.
    await run(
      transitionDelegationJob({
        at: LATER,
        dbPath,
        jobId: 'job-live',
        patch: { endedAt: LATER, result: { excerpt: null, kind: 'cancelled', review: null }, state: 'cancelled' },
      }),
    );
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-live', {
            author: 'automated-check',
            evaluationId: 'check-live',
            verdict: 'inconclusive',
          }),
        }),
      ),
    ).toEqual({ evaluationId: 'check-live', kind: 'recorded' });
    expect(await run(recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-live') }))).toEqual({
      kind: 'job-not-finished',
      state: 'cancelled',
    });
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-1', { evaluationId: 'a-1', kind: 'acceptance', verdict: 'taken-over' }),
        }),
      ),
    ).toEqual({ evaluationId: 'a-1', kind: 'recorded' });

    await request(dbPath, { idempotencyKey: 'caller:session-1:review-8', jobId: 'job-2' });
    await finish(dbPath, 'job-2');
    expect(
      await run(recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-2', { evaluationId: 'v-1' }) })),
    ).toEqual({ evaluationId: 'v-1', kind: 'recorded' });
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-2', {
            author: 'operator',
            authorLabel: 'web',
            evaluationId: 'a-2',
            kind: 'acceptance',
            recordedAt: '2026-10-25T10:12:00.000Z',
            verdict: 'accepted',
          }),
        }),
      ),
    ).toEqual({ evaluationId: 'a-2', kind: 'recorded' });
    const read = await run(queryDelegationEvaluations({ dbPath, jobIds: ['job-1', 'job-2'] }));
    expect(read.skipped).toBe(0);
    expect(read.evaluations.map(({ evaluationId }) => evaluationId)).toEqual(['a-2', 'v-1', 'check-1', 'a-1']);
    expect(read.evaluations[1]).toMatchObject({
      author: 'calling-model',
      authorLabel: 'claude-code',
      checks: ['bun test'],
      jobId: 'job-2',
      kind: 'verification',
      verdict: 'confirmed',
    });
    // A row that no longer re-validates is counted, not served.
    const raw = new Database(dbPath);
    raw.query("UPDATE delegation_evaluations SET verdict = 'accepted' WHERE evaluation_id = 'v-1'").run();
    raw.close();
    expect(await run(queryDelegationEvaluations({ dbPath, jobIds: ['job-2'] }))).toMatchObject({ skipped: 1 });
    expect(await run(queryDelegationEvaluations({ dbPath, jobIds: [] }))).toEqual({ evaluations: [], skipped: 0 });
  });

  test('keeps at most ten calling-model verifications and ten operator acceptances per job; the engine check is not counted', async () => {
    const dbPath = await createStore();
    await request(dbPath, { jobId: 'job-cap' });
    await finish(dbPath, 'job-cap');
    const limit = DELEGATION_STORE_BOUNDS.maxEvaluationsPerJobAuthor;
    expect(limit).toBe(10);
    for (let index = 0; index < limit; index++) {
      expect(
        await run(
          recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-cap', { evaluationId: `v-${index}` }) }),
        ),
      ).toEqual({ evaluationId: `v-${index}`, kind: 'recorded' });
    }
    expect(
      await run(recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-cap', { evaluationId: 'v-11th' }) })),
    ).toEqual({ author: 'calling-model', evaluationKind: 'verification', kind: 'limit-reached', limit });
    // Another author or kind has its own count: the operator's acceptances and the engine's check still record.
    const acceptance = (index: number) =>
      evaluation('job-cap', {
        author: 'operator',
        authorLabel: 'web',
        evaluationId: `a-${index}`,
        kind: 'acceptance',
        verdict: 'accepted',
      });
    for (let index = 0; index < limit; index++) {
      expect(await run(recordDelegationEvaluation({ dbPath, evaluation: acceptance(index) }))).toEqual({
        evaluationId: `a-${index}`,
        kind: 'recorded',
      });
    }
    expect(await run(recordDelegationEvaluation({ dbPath, evaluation: acceptance(limit) }))).toEqual({
      author: 'operator',
      evaluationKind: 'acceptance',
      kind: 'limit-reached',
      limit,
    });
    expect(
      await run(
        recordDelegationEvaluation({
          dbPath,
          evaluation: evaluation('job-cap', {
            author: 'automated-check',
            authorLabel: 'engine',
            evaluationId: 'check',
          }),
        }),
      ),
    ).toEqual({ evaluationId: 'check', kind: 'recorded' });
    // The cap is per job: another job starts its own count.
    await request(dbPath, { idempotencyKey: 'caller:session-1:review-cap-2', jobId: 'job-cap-2' });
    await finish(dbPath, 'job-cap-2');
    expect(
      await run(
        recordDelegationEvaluation({ dbPath, evaluation: evaluation('job-cap-2', { evaluationId: 'v-other' }) }),
      ),
    ).toEqual({ evaluationId: 'v-other', kind: 'recorded' });
    const read = await run(queryDelegationEvaluations({ dbPath, jobIds: ['job-cap'] }));
    expect(read.evaluations).toHaveLength(2 * limit + 1);
  });
});

describe('qualifications', () => {
  test('records, reads back and prunes qualifications a job does not cite', async () => {
    const dbPath = await createStore();
    const recorded = await run(
      recordDelegationQualification({
        dbPath,
        machineId: MACHINE,
        purpose: 'delegation',
        qualification: qualification(),
        requestDigest: 'd'.repeat(64),
      }),
    );
    expect(recorded).toEqual({ inserted: true, pruned: 0 });
    expect(
      await run(
        recordDelegationQualification({
          dbPath,
          machineId: MACHINE,
          purpose: 'delegation',
          qualification: qualification(),
          requestDigest: 'd'.repeat(64),
        }),
      ),
    ).toEqual({ inserted: false, pruned: 0 });
    const read = await run(
      readDelegationQualification({ dbPath, machineId: MACHINE, qualificationId: QUALIFICATION_ID }),
    );
    expect(read).toMatchObject({
      record: {
        policyRevision: 'pol0123456789abc',
        purpose: 'delegation',
        qualification: { qualificationId: QUALIFICATION_ID },
        requestDigest: 'd'.repeat(64),
        validUntil: LATER,
      },
      skipped: 0,
    });
    expect(
      await run(readDelegationQualification({ dbPath, machineId: 'elsewhere', qualificationId: QUALIFICATION_ID })),
    ).toEqual({
      record: null,
      skipped: 0,
    });
    // An old qualification goes on the next insert unless a job cites it.
    const oldId = '11111111-2222-4333-8444-555555555555';
    const citedId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const old = '2026-10-10T10:00:00.000Z';
    for (const [id, cite] of [
      [oldId, false],
      [citedId, true],
    ] as const) {
      await run(
        recordDelegationQualification({
          dbPath,
          machineId: MACHINE,
          purpose: 'simulation',
          qualification: qualification({ qualificationId: id, qualifiedAt: old, validUntil: old }),
          requestDigest: 'd'.repeat(64),
        }),
      );
      if (cite) {
        await request(dbPath, { qualificationId: id });
      }
    }
    const pruning = await run(
      recordDelegationQualification({
        dbPath,
        machineId: MACHINE,
        purpose: 'delegation',
        qualification: qualification({ qualificationId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', qualifiedAt: END }),
        requestDigest: 'd'.repeat(64),
      }),
    );
    expect(pruning).toEqual({ inserted: true, pruned: 1 });
    expect(
      (await run(readDelegationQualification({ dbPath, machineId: MACHINE, qualificationId: oldId }))).record,
    ).toBeNull();
    expect(
      (await run(readDelegationQualification({ dbPath, machineId: MACHINE, qualificationId: citedId }))).record,
    ).not.toBeNull();
    // Beyond the bound, the oldest uncited rows go.
    for (let index = 0; index < 505; index++) {
      await run(
        recordDelegationQualification({
          dbPath,
          machineId: MACHINE,
          purpose: 'simulation',
          qualification: qualification({
            qualificationId: `cccccccc-0000-4000-8000-${String(index).padStart(12, '0')}`,
            qualifiedAt: `2026-10-25T11:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
          }),
          requestDigest: 'd'.repeat(64),
        }),
      );
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const { count } = db.query('SELECT COUNT(*) AS count FROM delegation_qualifications').get() as { count: number };
      // 500 newest uncited rows plus the cited one.
      expect(count).toBe(501);
    } finally {
      db.close();
    }
    // A snapshot over the byte bound is refused, typed.
    await expect(
      run(
        recordDelegationQualification({
          dbPath,
          machineId: MACHINE,
          purpose: 'delegation',
          qualification: qualification({ assumptions: ['a'.repeat(50 * 1024)] }),
          requestDigest: 'd'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
  });
});

describe('read-only edge reads', () => {
  test('lists jobs with their evaluations newest first, bounds the page, and counts rows that no longer re-validate', async () => {
    const dbPath = await createStore();
    for (let index = 0; index < 3; index++) {
      await request(dbPath, {
        idempotencyKey: `caller:session-1:review-${index}`,
        jobId: `job-${index}`,
        requestedAt: `2026-10-25T10:0${index}:00.000Z`,
        scope: { ...scope, headSha: String(index).repeat(40) },
      });
      await finish(dbPath, `job-${index}`);
    }
    await run(
      recordDelegationEvaluation({
        dbPath,
        evaluation: {
          author: 'automated-check',
          authorLabel: 'engine',
          checks: [],
          evaluationId: 'check-2',
          jobId: 'job-2',
          kind: 'verification',
          note: null,
          recordedAt: END,
          verdict: 'confirmed',
        },
      }),
    );
    const page = await Effect.runPromise(readDelegationJobs({ dbPath, limit: 2, machineId: MACHINE }));
    expect(page).toMatchObject({ kind: 'ok', skipped: 0, truncated: true });
    if (page.kind !== 'ok') {
      throw new Error('expected ok');
    }
    expect(page.jobs.map(({ jobId }) => jobId)).toEqual(['job-2', 'job-1']);
    expect(page.evaluations.map(({ evaluationId }) => evaluationId)).toEqual(['check-2']);
    const one = await Effect.runPromise(readDelegationJob({ dbPath, jobId: 'job-0' }));
    expect(one).toMatchObject({ job: { jobId: 'job-0' }, kind: 'ok' });
    expect(await Effect.runPromise(readDelegationJob({ dbPath, jobId: 'nope' }))).toEqual({
      kind: 'not-found',
      skipped: 0,
    });
    expect(
      (await run(queryDelegationJobs({ dbPath, checkoutPath: CHECKOUT, states: ['finished'] }))).jobs,
    ).toHaveLength(3);
    // The caller's key is an exact match, scoped to the machine.
    const byKey = await run(
      queryDelegationJobs({ dbPath, idempotencyKey: 'caller:session-1:review-1', limit: 1, machineId: MACHINE }),
    );
    expect(byKey.jobs.map(({ jobId }) => jobId)).toEqual(['job-1']);
    expect(byKey.truncated).toBe(false);
    expect(
      (await run(queryDelegationJobs({ dbPath, idempotencyKey: 'caller:session-1:review-', machineId: MACHINE }))).jobs,
    ).toEqual([]);
    expect(
      (await run(queryDelegationJobs({ dbPath, idempotencyKey: 'caller:session-1:review-1', machineId: 'other' })))
        .jobs,
    ).toEqual([]);
    await expect(run(queryDelegationJobs({ dbPath, limit: 0 }))).rejects.toThrow();
    await expect(run(queryDelegationJobs({ dbPath, limit: 201 }))).rejects.toThrow();

    const raw = new Database(dbPath);
    raw.query("UPDATE delegation_jobs SET requested_at = 'yesterday' WHERE job_id = 'job-1'").run();
    raw.close();
    const revalidated = await Effect.runPromise(readDelegationJobs({ dbPath, machineId: MACHINE }));
    expect(revalidated).toMatchObject({ kind: 'ok', skipped: 1 });
    if (revalidated.kind === 'ok') {
      expect(revalidated.jobs.map(({ jobId }) => jobId)).toEqual(['job-2', 'job-0']);
    }
  });

  test('a missing store is a typed answer and is never created', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-delegation-missing-'));
    roots.push(root);
    const missing = path.join(root, 'usage-store.sqlite');
    expect(await Effect.runPromise(readDelegationJobs({ dbPath: missing }))).toEqual({ kind: 'store-missing' });
    expect(await Effect.runPromise(readDelegationJob({ dbPath: missing, jobId: 'x' }))).toEqual({
      kind: 'store-missing',
    });
    await expect(stat(missing)).rejects.toThrow();
    await expect(run(queryDelegationJobs({ dbPath: missing }))).rejects.toMatchObject({ reason: 'store-missing' });
    await expect(stat(missing)).rejects.toThrow();
  });

  test('the edge read classifies a corrupt store instead of throwing', async () => {
    const dbPath = await createStore();
    await Bun.write(dbPath, 'not a database at all');
    expect(await Effect.runPromise(readDelegationJobs({ dbPath }))).toMatchObject({ kind: 'incompatible-store' });
  });
});
