import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { REVIEW_ATTEMPT_BOUNDS, type ReviewAttemptTarget } from '@ai-usage/report-core/work-attempts';
import { parseClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import type { ExecutorDeclaration } from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { queryReviewAttempts, queryReviewTargetResolution } from './reader';
import type { NewReviewAttempt } from './review-attempt-store';
import {
  importClaudeDesktopSessions,
  initializeUsageStore,
  markReviewAttemptsLost,
  publishServedReportRevision,
  releaseReviewAttemptReservation,
  requestReviewAttempt,
  transitionReviewAttempt,
  updateUsageMachineLabel,
} from './writer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-attempts';
const NOW = '2026-10-22T10:00:00.000Z';
const LATER = '2026-10-22T10:00:15.000Z';
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
  checkoutPath: '/home/fixture/work/project',
  desktopSessionId: 'local_one',
  harness: 'claude',
  projectLabel: 'project',
  sessionTitle: 'Fixture: desktop session',
  sourceSessionId: 'cli-1',
};
const newAttempt = (overrides: Partial<NewReviewAttempt> = {}): NewReviewAttempt => ({
  candidateId: 'declared:["machine-attempts","claude-code","personal"]',
  declaration,
  executorHarness: 'claude-code',
  idempotencyKey: 'k'.repeat(64),
  machineId: MACHINE,
  requestedAt: NOW,
  state: 'requested',
  target,
  ...overrides,
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-review-attempts-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const run = <Value>(effect: Effect.Effect<Value, UsageStoreError>): Promise<Value> => Effect.runPromise(effect);

describe('review attempt store', () => {
  test('persists the native turn and separate stop observations without releasing a running attempt', async () => {
    const dbPath = await createStore();
    const created = await run(requestReviewAttempt({ dbPath, attempt: newAttempt({ executorHarness: 'codex' }) }));
    const attemptId = created.attempt.attemptId;
    await run(
      transitionReviewAttempt({
        dbPath,
        attemptId,
        at: LATER,
        patch: {
          state: 'running',
          nativeSessionId: 'native-thread',
          nativeTurnId: 'native-turn',
          stopRequestedAt: LATER,
        },
      }),
    );
    const running = await run(queryReviewAttempts({ dbPath, reserving: true }));
    expect(running.attempts[0]).toMatchObject({
      attemptId,
      state: 'running',
      nativeSessionId: 'native-thread',
      nativeTurnId: 'native-turn',
      stopRequestedAt: LATER,
      stopConfirmedAt: null,
    });
    const duplicate = await run(requestReviewAttempt({ dbPath, attempt: newAttempt({ executorHarness: 'codex' }) }));
    expect(duplicate.reused).toBe(true);
    expect(duplicate.attempt.attemptId).toBe(attemptId);
    await run(
      transitionReviewAttempt({
        dbPath,
        attemptId,
        at: '2026-10-22T10:00:30.000Z',
        patch: {
          state: 'failed',
          stopConfirmedAt: '2026-10-22T10:00:30.000Z',
          resultExcerpt: 'Partial review retained',
          resultKind: 'error',
        },
      }),
    );
    const ended = await run(queryReviewAttempts({ dbPath }));
    expect(ended.attempts[0]).toMatchObject({
      stopRequestedAt: LATER,
      stopConfirmedAt: '2026-10-22T10:00:30.000Z',
      resultExcerpt: 'Partial review retained',
    });
    expect((await run(queryReviewAttempts({ dbPath, reserving: true }))).attempts).toHaveLength(0);
  });

  test('upgrades legacy review attempts with unknown stop evidence while retaining the reservation', async () => {
    const dbPath = await createStore();
    const created = await run(requestReviewAttempt({ dbPath, attempt: newAttempt() }));
    const db = new Database(dbPath);
    try {
      for (const column of ['native_turn_id', 'stop_requested_at', 'stop_confirmed_at']) {
        db.exec(`ALTER TABLE review_attempts DROP COLUMN ${column}`);
      }
    } finally {
      db.close();
    }
    const readBeforeUpgrade = await Effect.runPromiseExit(queryReviewAttempts({ dbPath }));
    expect(readBeforeUpgrade._tag).toBe('Failure');
    await run(initializeUsageStore({ dbPath }));
    const upgraded = await run(queryReviewAttempts({ dbPath, reserving: true }));
    expect(upgraded.attempts[0]).toMatchObject({
      attemptId: created.attempt.attemptId,
      nativeTurnId: null,
      stopRequestedAt: null,
      stopConfirmedAt: null,
    });
  });

  test('creates the additive table on open without touching user_version', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'review_attempts'").get(),
      ).toEqual({
        name: 'review_attempts',
      });
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
      const indexes = db
        .query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'review_attempts'")
        .all() as { name: string }[];
      expect(
        indexes
          .map(({ name }) => name)
          .filter((name) => !name.startsWith('sqlite_autoindex'))
          .sort(),
      ).toEqual(['idx_review_attempts_reserved_identity', 'idx_review_attempts_target']);
      const columns = (db.query('PRAGMA table_info(review_attempts)').all() as { name: string }[]).map(
        ({ name }) => name,
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          'launch_session_id',
          'released_at',
          'release_evidence',
          'scope_json',
          'guarantee_json',
        ]),
      );
    } finally {
      db.close();
    }
  });

  test('upgrades a table created by the first version: adds the columns, releases its lost rows by name, swaps the index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'usage-store-review-attempts-legacy-'));
    roots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await run(initializeUsageStore({ dbPath }));
    // Rebuild the table exactly as the first version created it, with two lost rows on one key
    // (the earlier rule allowed that) and one live row.
    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        DROP TABLE review_attempts;
        CREATE TABLE review_attempts (
          attempt_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('read-only-review')), target_harness TEXT NOT NULL,
          source_session_id TEXT NOT NULL, desktop_session_id TEXT, checkout_path TEXT,
          checkout_origin TEXT CHECK (checkout_origin IS NULL OR checkout_origin IN ('desktop-worktree', 'desktop-cwd', 'served-session')),
          project_label TEXT, session_title TEXT, candidate_id TEXT NOT NULL,
          executor_harness TEXT NOT NULL CHECK (executor_harness IN ('claude-code', 'codex')), declaration_json TEXT,
          state TEXT NOT NULL CHECK (state IN ('requested', 'starting', 'running', 'finished', 'failed', 'refused', 'lost')),
          requested_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, native_session_id TEXT,
          pid INTEGER, exit_code INTEGER,
          result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('review', 'error', 'timeout')),
          result_excerpt TEXT, num_turns INTEGER, duration_ms INTEGER, validations_json TEXT NOT NULL DEFAULT '[]',
          acceptance TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
          failure_reason TEXT
        );
        CREATE INDEX idx_review_attempts_target ON review_attempts(machine_id, target_harness, source_session_id, requested_at DESC);
        CREATE UNIQUE INDEX idx_review_attempts_live_identity ON review_attempts(idempotency_key) WHERE state IN ('requested', 'starting', 'running');
      `);
      const insert = legacy.query(`
        INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id,
          candidate_id, executor_harness, state, requested_at, ended_at, updated_at)
        VALUES (?, '${MACHINE}', ?, 'read-only-review', 'claude', 'cli-1', 'candidate', 'claude-code', ?, ?, ?, ?)
      `);
      insert.run('lost-1', 'k'.repeat(64), 'lost', NOW, LATER, LATER);
      insert.run('lost-2', 'k'.repeat(64), 'lost', LATER, '2026-10-22T10:01:00.000Z', '2026-10-22T10:01:00.000Z');
      insert.run('live-1', 'k'.repeat(64), 'running', '2026-10-22T10:02:00.000Z', null, '2026-10-22T10:02:00.000Z');
    } finally {
      legacy.close();
    }
    await run(initializeUsageStore({ dbPath }));
    // Idempotent: a second open changes nothing.
    await run(initializeUsageStore({ dbPath }));
    const db = new Database(dbPath, { readonly: true });
    try {
      const indexes = (
        db.query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'review_attempts'").all() as {
          name: string;
        }[]
      ).map(({ name }) => name);
      expect(indexes).toContain('idx_review_attempts_reserved_identity');
      expect(indexes).not.toContain('idx_review_attempts_live_identity');
    } finally {
      db.close();
    }
    const byId = new Map((await run(queryReviewAttempts({ dbPath }))).attempts.map((row) => [row.attemptId, row]));
    expect(byId.get('lost-1')).toMatchObject({ releaseEvidence: 'recorded-before-reservations', releasedAt: LATER });
    expect(byId.get('lost-2')).toMatchObject({
      releaseEvidence: 'recorded-before-reservations',
      releasedAt: '2026-10-22T10:01:00.000Z',
    });
    expect(byId.get('live-1')).toMatchObject({
      launchSessionId: null,
      releasedAt: null,
      scope: null,
      state: 'running',
    });
  });

  test('rebuilds a table whose release evidence predates the operator declaration, keeping every row (ADR 0055)', async () => {
    const dbPath = await createStore();
    // The table as the reservation version created it: its release_evidence check names three values.
    const previous = new Database(dbPath);
    try {
      previous.exec(`
        DROP TABLE review_attempts;
        CREATE TABLE review_attempts (
          attempt_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('read-only-review')), target_harness TEXT NOT NULL,
          source_session_id TEXT NOT NULL, desktop_session_id TEXT, checkout_path TEXT,
          checkout_origin TEXT CHECK (checkout_origin IS NULL OR checkout_origin IN ('desktop-worktree', 'desktop-cwd', 'served-session')),
          project_label TEXT, session_title TEXT, candidate_id TEXT NOT NULL,
          executor_harness TEXT NOT NULL CHECK (executor_harness IN ('claude-code', 'codex')), declaration_json TEXT,
          state TEXT NOT NULL CHECK (state IN ('requested', 'starting', 'running', 'finished', 'failed', 'refused', 'lost')),
          requested_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, native_session_id TEXT,
          pid INTEGER, exit_code INTEGER,
          result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('review', 'error', 'timeout')),
          result_excerpt TEXT, num_turns INTEGER, duration_ms INTEGER, validations_json TEXT NOT NULL DEFAULT '[]',
          acceptance TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
          failure_reason TEXT, launch_session_id TEXT, released_at TEXT,
          release_evidence TEXT CHECK (release_evidence IS NULL OR release_evidence IN ('process-absent', 'outcome-recorded-late', 'recorded-before-reservations')),
          scope_json TEXT, guarantee_json TEXT
        );
        CREATE INDEX idx_review_attempts_target ON review_attempts(machine_id, target_harness, source_session_id, requested_at DESC);
        CREATE UNIQUE INDEX idx_review_attempts_reserved_identity ON review_attempts(idempotency_key)
          WHERE (state IN ('requested', 'starting', 'running') OR (state = 'lost' AND released_at IS NULL));
      `);
      previous
        .query(`
          INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id,
            candidate_id, executor_harness, state, requested_at, ended_at, updated_at, failure_reason)
          VALUES ('legacy-lost', '${MACHINE}', ?, 'read-only-review', 'claude', 'cli-1', 'candidate', 'claude-code',
            'lost', ?, ?, ?, 'engine restarted while running')
        `)
        .run('k'.repeat(64), NOW, LATER, LATER);
    } finally {
      previous.close();
    }
    await run(initializeUsageStore({ dbPath }));
    await run(initializeUsageStore({ dbPath }));
    const [held] = (await run(queryReviewAttempts({ dbPath }))).attempts;
    expect(held).toMatchObject({ attemptId: 'legacy-lost', launchSessionId: null, releasedAt: null, state: 'lost' });

    const declaredAt = '2026-10-22T11:00:00.000Z';
    const released = await run(
      releaseReviewAttemptReservation({
        at: declaredAt,
        attemptId: 'legacy-lost',
        dbPath,
        evidence: 'operator-declared-ended',
      }),
    );
    expect(released.applied).toBe(true);
    const [after] = (await run(queryReviewAttempts({ dbPath }))).attempts;
    expect(after).toMatchObject({
      failureReason: 'engine restarted while running',
      releaseEvidence: 'operator-declared-ended',
      releasedAt: declaredAt,
      state: 'lost',
    });
    // The identity is free again: a new request opens a new attempt instead of reusing the lost one.
    const next = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'after-release' }), dbPath }));
    expect(next).toMatchObject({ attempt: { attemptId: 'after-release' }, reused: false });
    const db = new Database(dbPath, { readonly: true });
    try {
      const indexes = (
        db.query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'review_attempts'").all() as {
          name: string;
        }[]
      ).map(({ name }) => name);
      expect(indexes.sort()).toEqual([
        'idx_review_attempts_reserved_identity',
        'idx_review_attempts_target',
        'sqlite_autoindex_review_attempts_1',
      ]);
    } finally {
      db.close();
    }
  });

  test('a store whose review attempts predate the reservation columns reads as not upgraded yet, typed', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath);
    try {
      db.exec(`
        DROP TABLE review_attempts;
        CREATE TABLE review_attempts (
          attempt_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, action TEXT NOT NULL,
          target_harness TEXT NOT NULL, source_session_id TEXT NOT NULL, desktop_session_id TEXT, checkout_path TEXT,
          checkout_origin TEXT, project_label TEXT, session_title TEXT, candidate_id TEXT NOT NULL,
          executor_harness TEXT NOT NULL, declaration_json TEXT, state TEXT NOT NULL, requested_at TEXT NOT NULL,
          started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, native_session_id TEXT, pid INTEGER, exit_code INTEGER,
          result_kind TEXT, result_excerpt TEXT, num_turns INTEGER, duration_ms INTEGER,
          validations_json TEXT NOT NULL DEFAULT '[]', acceptance TEXT NOT NULL DEFAULT 'pending', failure_reason TEXT
        );
      `);
    } finally {
      db.close();
    }
    const error = await Effect.runPromise(Effect.flip(queryReviewAttempts({ dbPath })));
    expect(error).toMatchObject({ reason: 'schema-too-old' });
    expect(error.message).toContain('next engine start');
  });

  test('inserts one live attempt per identity and returns the existing one to a second request', async () => {
    const dbPath = await createStore();
    const first = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-1' }), dbPath }));
    expect(first).toMatchObject({
      attempt: { attemptId: 'attempt-1', state: 'requested', acceptance: 'pending' },
      reused: false,
    });
    expect(first.attempt.declaration).toEqual(declaration);
    expect(first.attempt.validations).toEqual([]);

    const second = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-2' }), dbPath }));
    expect(second).toMatchObject({ attempt: { attemptId: 'attempt-1' }, reused: true });

    // A refusal is recorded beside the live attempt and never blocks or reuses it.
    const refused = await run(
      requestReviewAttempt({
        attempt: newAttempt({
          attemptId: 'attempt-3',
          failureReason: 'target-not-allowed: add routing.reviewTargets for /x',
          state: 'refused',
        }),
        dbPath,
      }),
    );
    expect(refused).toMatchObject({ attempt: { attemptId: 'attempt-3', state: 'refused' }, reused: false });

    // Once the live attempt ends, the identity is free again.
    await run(
      transitionReviewAttempt({
        at: LATER,
        attemptId: 'attempt-1',
        dbPath,
        patch: { endedAt: LATER, exitCode: 0, resultExcerpt: 'Findings', resultKind: 'review', state: 'finished' },
      }),
    );
    const third = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-4' }), dbPath }));
    expect(third).toMatchObject({ attempt: { attemptId: 'attempt-4', state: 'requested' }, reused: false });

    const listed = await run(queryReviewAttempts({ dbPath, target: { harness: 'claude', sourceSessionId: 'cli-1' } }));
    expect(listed.attempts.map(({ attemptId }) => attemptId)).toEqual(['attempt-4', 'attempt-3', 'attempt-1']);
    expect(listed).toMatchObject({ skipped: 0, truncated: false });
  });

  test('guards transitions by state and bounds the written text', async () => {
    const dbPath = await createStore();
    await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-1' }), dbPath }));
    expect(
      await run(
        transitionReviewAttempt({
          at: LATER,
          attemptId: 'attempt-1',
          dbPath,
          patch: { pid: 4242, startedAt: LATER, state: 'starting' },
        }),
      ),
    ).toEqual({ applied: true });
    expect(
      await run(
        transitionReviewAttempt({
          at: LATER,
          attemptId: 'attempt-1',
          dbPath,
          patch: { nativeSessionId: 'native-1', state: 'running' },
        }),
      ),
    ).toEqual({ applied: true });
    // A step out of `requested` is refused once the harness reported `running`: no step back.
    expect(
      await run(
        transitionReviewAttempt({
          at: LATER,
          attemptId: 'attempt-1',
          dbPath,
          fromStates: ['requested'],
          patch: { pid: 4243, state: 'starting' },
        }),
      ),
    ).toEqual({ applied: false });
    // A heartbeat is an empty patch from a live state.
    expect(
      await run(transitionReviewAttempt({ at: '2026-10-22T10:00:30.000Z', attemptId: 'attempt-1', dbPath, patch: {} })),
    ).toEqual({
      applied: true,
    });
    expect(
      await run(
        transitionReviewAttempt({
          at: '2026-10-22T10:01:00.000Z',
          attemptId: 'attempt-1',
          dbPath,
          patch: {
            durationMs: 45_000,
            endedAt: '2026-10-22T10:01:00.000Z',
            exitCode: 1,
            failureReason: 'f'.repeat(2000),
            numTurns: 8,
            resultExcerpt: 'e'.repeat(10_000),
            resultKind: 'error',
            state: 'failed',
          },
        }),
      ),
    ).toEqual({ applied: true });
    // Late writes from the finished process cannot resurrect the row.
    expect(
      await run(transitionReviewAttempt({ at: '2026-10-22T10:02:00.000Z', attemptId: 'attempt-1', dbPath, patch: {} })),
    ).toEqual({
      applied: false,
    });
    expect(
      await run(
        transitionReviewAttempt({
          at: '2026-10-22T10:02:00.000Z',
          attemptId: 'attempt-1',
          dbPath,
          patch: { state: 'running' },
        }),
      ),
    ).toEqual({ applied: false });
    expect(await run(transitionReviewAttempt({ at: LATER, attemptId: 'missing', dbPath, patch: {} }))).toEqual({
      applied: false,
    });

    const [attempt] = (await run(queryReviewAttempts({ dbPath }))).attempts;
    expect(attempt).toMatchObject({
      durationMs: 45_000,
      exitCode: 1,
      nativeSessionId: 'native-1',
      numTurns: 8,
      pid: 4242,
      resultKind: 'error',
      startedAt: LATER,
      state: 'failed',
      updatedAt: '2026-10-22T10:01:00.000Z',
    });
    expect(attempt?.resultExcerpt?.length).toBe(REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
    expect(attempt?.failureReason?.length).toBe(REVIEW_ATTEMPT_BOUNDS.maxFailureReason);
  });

  test('marks every live attempt of the machine lost with a bounded reason and leaves the rest alone', async () => {
    const dbPath = await createStore();
    await run(
      requestReviewAttempt({
        attempt: newAttempt({ attemptId: 'requested-1', idempotencyKey: 'a'.repeat(64) }),
        dbPath,
      }),
    );
    await run(
      requestReviewAttempt({ attempt: newAttempt({ attemptId: 'running-1', idempotencyKey: 'b'.repeat(64) }), dbPath }),
    );
    await run(
      transitionReviewAttempt({ at: LATER, attemptId: 'running-1', dbPath, patch: { pid: 77, state: 'running' } }),
    );
    await run(
      requestReviewAttempt({ attempt: newAttempt({ attemptId: 'done-1', idempotencyKey: 'c'.repeat(64) }), dbPath }),
    );
    await run(
      transitionReviewAttempt({ at: LATER, attemptId: 'done-1', dbPath, patch: { state: 'finished', endedAt: LATER } }),
    );
    await run(
      requestReviewAttempt({
        attempt: newAttempt({ attemptId: 'other-machine', idempotencyKey: 'd'.repeat(64), machineId: 'elsewhere' }),
        dbPath,
      }),
    );

    const lost = await run(
      markReviewAttemptsLost({
        at: '2026-10-22T11:00:00.000Z',
        dbPath,
        machineId: MACHINE,
        reason: ({ pid, state }) => `engine restarted while ${state}${pid === null ? '' : ` (pid ${pid})`}`,
      }),
    );
    expect([...lost.lost].sort()).toEqual(['requested-1', 'running-1']);
    const all = await run(queryReviewAttempts({ dbPath }));
    const byId = new Map(all.attempts.map((attempt) => [attempt.attemptId, attempt]));
    expect(byId.get('running-1')).toMatchObject({
      endedAt: '2026-10-22T11:00:00.000Z',
      failureReason: 'engine restarted while running (pid 77)',
      state: 'lost',
    });
    expect(byId.get('requested-1')?.state).toBe('lost');
    expect(byId.get('done-1')?.state).toBe('finished');
    expect(byId.get('other-machine')?.state).toBe('requested');
    expect((await run(queryReviewAttempts({ dbPath, states: ['lost'] }))).attempts).toHaveLength(2);
    expect((await run(queryReviewAttempts({ dbPath, machineId: 'elsewhere' }))).attempts).toHaveLength(1);
  });

  test('a lost attempt keeps its reservation until it is released with evidence; heartbeats never release it', async () => {
    const dbPath = await createStore();
    const launchSessionId = '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
    const requested = await run(
      requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-1', launchSessionId }), dbPath }),
    );
    expect(requested.attempt).toMatchObject({ launchSessionId, releasedAt: null, state: 'requested' });
    await run(
      transitionReviewAttempt({ at: LATER, attemptId: 'attempt-1', dbPath, patch: { pid: 4242, state: 'running' } }),
    );
    await run(markReviewAttemptsLost({ at: LATER, dbPath, machineId: MACHINE, reason: () => 'engine restarted' }));

    // The same identity is still reserved: a second request returns the lost row and inserts nothing.
    const blocked = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-2' }), dbPath }));
    expect(blocked).toMatchObject({ attempt: { attemptId: 'attempt-1', state: 'lost' }, reused: true });
    // The unique index enforces it below the code path too.
    const raw = new Database(dbPath);
    try {
      expect(() =>
        raw
          .query(`
            INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness,
              source_session_id, candidate_id, executor_harness, state, requested_at, updated_at)
            VALUES ('twin', '${MACHINE}', '${'k'.repeat(64)}', 'read-only-review', 'claude', 'cli-1', 'c', 'claude-code', 'requested', '${NOW}', '${NOW}')
          `)
          .run(),
      ).toThrow('UNIQUE');
    } finally {
      raw.close();
    }
    // A late heartbeat from the old process's engine is not applied and releases nothing.
    expect(
      await run(transitionReviewAttempt({ at: '2026-10-22T10:00:30.000Z', attemptId: 'attempt-1', dbPath, patch: {} })),
    ).toEqual({ applied: false });
    expect(
      (await run(queryReviewAttempts({ dbPath, reserving: true }))).attempts.map(({ attemptId }) => attemptId),
    ).toEqual(['attempt-1']);
    // Release only from `lost`, never from another state.
    expect(
      await run(
        releaseReviewAttemptReservation({
          at: LATER,
          attemptId: 'missing',
          dbPath,
          evidence: 'process-absent',
        }),
      ),
    ).toEqual({ applied: false });

    // A late outcome from the launching engine is recorded on the lost row and releases it; the
    // first evidence stands when a second release arrives.
    expect(
      await run(
        releaseReviewAttemptReservation({
          at: '2026-10-22T10:01:00.000Z',
          attemptId: 'attempt-1',
          dbPath,
          evidence: 'outcome-recorded-late',
          outcome: {
            durationMs: 50_000,
            exitCode: 0,
            nativeSessionId: launchSessionId,
            numTurns: 3,
            resultExcerpt: 'Finding 1: late.',
            resultKind: 'review',
          },
        }),
      ),
    ).toEqual({ applied: true });
    await run(
      releaseReviewAttemptReservation({
        at: '2026-10-22T10:02:00.000Z',
        attemptId: 'attempt-1',
        dbPath,
        evidence: 'process-absent',
      }),
    );
    const [lost] = (await run(queryReviewAttempts({ dbPath, states: ['lost'] }))).attempts;
    expect(lost).toMatchObject({
      exitCode: 0,
      failureReason: 'engine restarted',
      releaseEvidence: 'outcome-recorded-late',
      releasedAt: '2026-10-22T10:01:00.000Z',
      resultExcerpt: 'Finding 1: late.',
      state: 'lost',
    });
    expect((await run(queryReviewAttempts({ dbPath, reserving: true }))).attempts).toEqual([]);
    const free = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-3' }), dbPath }));
    expect(free).toMatchObject({ attempt: { attemptId: 'attempt-3', state: 'requested' }, reused: false });
  });

  test('two concurrent requests on one identity insert one attempt, whichever connection wins', async () => {
    const dbPath = await createStore();
    const results = await Promise.all([
      run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'client-a' }), dbPath })),
      run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'client-b' }), dbPath })),
    ]);
    expect(results.filter((result) => !result.reused)).toHaveLength(1);
    expect(new Set(results.map((result) => result.attempt.attemptId)).size).toBe(1);
    expect((await run(queryReviewAttempts({ dbPath }))).attempts).toHaveLength(1);
  });

  test('records the reviewed scope and the harness guarantee with the launch and reads them back', async () => {
    const dbPath = await createStore();
    await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-1' }), dbPath }));
    const scope = {
      base: 'empty-tree' as const,
      baseSha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      fileCount: 1,
      files: [
        {
          additions: 1,
          coverage: 'complete' as const,
          deletions: 0,
          path: 'a.txt',
          previousPath: null,
          status: 'added' as const,
        },
      ],
      headSha: 'a'.repeat(40),
      includedBytes: 80,
      includedLines: 6,
      kind: 'commit' as const,
      parentCount: 0,
      patchBytes: 80,
      patchLines: 6,
      patchSha256: 'e'.repeat(64),
      repositoryPrefix: '',
      subject: 'first',
      truncated: false,
      workingTreeDirty: false,
    };
    const guarantee = {
      cliVersion: '2.1.306',
      effort: null,
      model: 'opus',
      managedSettings: 'absent' as const,
      safeMode: true,
      settingSources: [],
      tools: ['Read', 'Grep', 'Glob'] as const,
    };
    await run(
      transitionReviewAttempt({
        at: LATER,
        attemptId: 'attempt-1',
        dbPath,
        patch: { guarantee, pid: 99, scope, state: 'starting' },
      }),
    );
    const [attempt] = (await run(queryReviewAttempts({ dbPath }))).attempts;
    expect(attempt).toMatchObject({ guarantee, scope, state: 'starting' });
    // A scope that no longer re-validates hides the row rather than serving it.
    const raw = new Database(dbPath);
    try {
      raw.query(`UPDATE review_attempts SET scope_json = '{"kind":"pull-request"}'`).run();
    } finally {
      raw.close();
    }
    expect(await run(queryReviewAttempts({ dbPath }))).toMatchObject({ attempts: [], skipped: 1 });
  });

  test('bounds the list, reports truncation and counts rows that no longer re-validate', async () => {
    const dbPath = await createStore();
    for (let index = 0; index < 4; index++) {
      await run(
        requestReviewAttempt({
          attempt: newAttempt({
            attemptId: `attempt-${index}`,
            idempotencyKey: String(index).repeat(64),
            requestedAt: `2026-10-22T10:0${index}:00.000Z`,
          }),
          dbPath,
        }),
      );
    }
    const page = await run(queryReviewAttempts({ dbPath, limit: 2 }));
    expect(page.attempts.map(({ attemptId }) => attemptId)).toEqual(['attempt-3', 'attempt-2']);
    expect(page.truncated).toBe(true);
    await expect(run(queryReviewAttempts({ dbPath, limit: 0 }))).rejects.toThrow();
    await expect(run(queryReviewAttempts({ dbPath, limit: REVIEW_ATTEMPT_BOUNDS.maxListLimit + 1 }))).rejects.toThrow();

    const db = new Database(dbPath);
    try {
      db.query("UPDATE review_attempts SET requested_at = 'yesterday' WHERE attempt_id = 'attempt-0'").run();
    } finally {
      db.close();
    }
    const revalidated = await run(queryReviewAttempts({ dbPath }));
    expect(revalidated.attempts.map(({ attemptId }) => attemptId)).toEqual(['attempt-3', 'attempt-2', 'attempt-1']);
    expect(revalidated.skipped).toBe(1);
  });

  test('resolves the target from the Desktop session and the served Session at the current revision', async () => {
    const dbPath = await createStore();
    const machine = { id: MACHINE, label: 'Attempt Machine' };
    await run(updateUsageMachineLabel({ dbPath, machine }));
    const desktopInput = {
      accountDirectory: 'account-a',
      archived: false,
      branch: null,
      cliSessionId: 'cli-1',
      completedTurns: 1,
      createdAt: '2026-10-19T08:00:00.000Z',
      cwd: '/home/fixture/work/project',
      declaredPullRequests: [],
      desktopSessionId: 'local_one',
      effort: null,
      fileModifiedAt: '2026-10-20T09:00:00.000Z',
      filePath: '.config/Claude/claude-code-sessions/account-a/org-a/local_one.json',
      format: 'claude-desktop-session-v1',
      lastActivityAt: '2026-10-20T09:00:00.000Z',
      lastTurnReport: null,
      machineId: MACHINE,
      model: null,
      observedAt: '2026-10-20T09:05:00.000Z',
      openSuggestions: [],
      organizationDirectory: 'org-a',
      originCwd: null,
      priorCliSessionIds: [],
      resolvedSuggestions: {},
      sideSessionNotes: [],
      sourceBranch: null,
      spawnedFrom: null,
      title: 'Fixture: desktop session',
      titleSource: 'auto',
      turnSummary: null,
      unsupportedReason: null,
      worktreePath: '/home/fixture/work/project/.claude/worktrees/w1',
      wrapUpDescription: null,
      writtenBranches: [],
    };
    const desktop = parseClaudeDesktopSessionObservation(desktopInput);
    // Another Desktop session of the same machine, on another transcript.
    const otherDesktop = parseClaudeDesktopSessionObservation({
      ...desktopInput,
      cliSessionId: 'cli-2',
      desktopSessionId: 'local_two',
      filePath: '.config/Claude/claude-code-sessions/account-a/org-a/local_two.json',
      title: 'Fixture: another desktop session',
      worktreePath: null,
    });
    if (desktop === null || otherDesktop === null) {
      throw new Error('fixture must parse');
    }
    await run(
      importClaudeDesktopSessions({
        completeness: { filesParsed: 2, filesSeen: 2, rejected: 0, truncated: false, unsupported: 0 },
        dbPath,
        machineId: MACHINE,
        observations: [desktop, otherDesktop],
      }),
    );
    const beforeRevision = await run(
      queryReviewTargetResolution({ dbPath, harness: 'claude', machineId: MACHINE, sourceSessionId: 'cli-1' }),
    );
    expect(beforeRevision).toEqual({
      desktop: {
        cwd: '/home/fixture/work/project',
        desktopSessionId: 'local_one',
        title: 'Fixture: desktop session',
        worktreePath: '/home/fixture/work/project/.claude/worktrees/w1',
      },
      session: null,
    });

    const servedRow: SerializedRow = {
      activeDate: '2026-10-20T08:01:00.000Z',
      calls: 1,
      costActual: 0.1,
      costApprox: 0.1,
      costKnown: true,
      costQuota: 0,
      date: '2026-10-20T08:00:00.000Z',
      durationMs: 1000,
      endDate: '2026-10-20T08:01:00.000Z',
      freshTokens: 30,
      harness: 'Claude Code',
      lineDelta: 0,
      linesAdded: 0,
      linesDeleted: 0,
      model: 'claude-fixture',
      name: 'Served session',
      project: 'project',
      provider: 'Claude sub',
      sessionLabel: 'Served session',
      source: {
        harnessKey: 'claude',
        machineId: MACHINE,
        machineLabel: machine.label,
        rootSourceSessionId: 'cli-1',
        sourcePath: '/home/fixture/work/project',
        sourceSessionId: 'cli-1',
      },
      tokCr: 0,
      tokCw: 0,
      tokIn: 10,
      tokOut: 20,
      tokenTotal: 30,
      tools: 0,
      turns: 1,
    };
    const support: FocusedReportSupport = {
      analytics: {
        averageDurationMs: null,
        byHarness: [],
        byModel: [],
        byProvider: [],
        costPer100Lines: null,
        durationMs: 0,
        durationRows: 0,
        lineCount: 0,
        linesA: 0,
        linesD: 0,
        meanCost: 0,
        medianCost: 0,
        pricedCount: 0,
        recentSessions: 0,
        sessionCount: 1,
        tools: 0,
        totalCost: 0,
        turns: 0,
        unpricedCount: 0,
      },
      filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      generatedAt: '2026-10-20T09:10:00.000Z',
      machineFreshness: {
        kind: 'available',
        machines: [{ id: MACHINE, label: machine.label, lastSeenAt: '2026-10-20T09:10:00.000Z' }],
        observedAt: '2026-10-20T09:10:00.000Z',
        omittedMachines: 0,
        skippedRows: 0,
      },
      omittedRows: 0,
      timeZone: 'UTC',
    };
    await run(
      publishServedReportRevision({
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: support.generatedAt,
          projectAliases: [],
          projectGroupConfigs: [],
          rows: [servedRow],
          sourceAuthorities: ['local-observed'],
          support,
        }),
        dbPath,
        now: 1000,
        revision: 'revision-attempts',
        ttlMs: 300_000,
      }),
    );
    const resolved = await run(
      queryReviewTargetResolution({ dbPath, harness: 'claude', machineId: MACHINE, sourceSessionId: 'cli-1' }),
    );
    expect(resolved.session).toEqual({
      name: 'Served session',
      projectLabel: 'project',
      sourcePath: '/home/fixture/work/project',
    });
    // A named Desktop session must be the one that declared this transcript: another session's
    // id resolves no Desktop checkout, whatever it names.
    const named = (desktopSessionId: string, sourceSessionId = 'cli-1') =>
      run(
        queryReviewTargetResolution({
          dbPath,
          desktopSessionId,
          harness: 'claude',
          machineId: MACHINE,
          sourceSessionId,
        }),
      );
    expect((await named('local_one')).desktop?.desktopSessionId).toBe('local_one');
    expect((await named('local_two')).desktop).toBeNull();
    expect((await named('local_two')).session?.name).toBe('Served session');
    expect((await named('local_two', 'cli-2')).desktop?.desktopSessionId).toBe('local_two');
    // Another harness never joins the Desktop registry, even when a desktop id is named; an
    // unknown session resolves to nothing.
    expect(
      await run(
        queryReviewTargetResolution({ dbPath, harness: 'codex', machineId: MACHINE, sourceSessionId: 'cli-1' }),
      ),
    ).toEqual({ desktop: null, session: null });
    expect(
      await run(
        queryReviewTargetResolution({
          dbPath,
          desktopSessionId: 'local_one',
          harness: 'codex',
          machineId: MACHINE,
          sourceSessionId: 'other',
        }),
      ),
    ).toEqual({ desktop: null, session: null });
  });
});
