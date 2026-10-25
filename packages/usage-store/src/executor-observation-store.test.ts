import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { MAX_EXECUTOR_OBSERVATION_HISTORY } from './executor-observation-store';
import {
  importExecutorObservations,
  initializeUsageStore,
  queryExecutorObservationHistory,
  queryLatestExecutorObservations,
} from './writer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-history';

const observation = (
  harness: ExecutorObservation['harness'],
  observedAt: string,
  accountFingerprint?: string,
): ExecutorObservation => ({
  ...(accountFingerprint === undefined ? {} : { accountFingerprint }),
  authEvidence: `${harness} status exit 0`,
  authMethod: null,
  authState: 'logged-in',
  binaryPath: `/usr/local/bin/${harness}`,
  harness,
  machineId: MACHINE,
  observedAt,
  outcome: 'observed',
  version: '1.0.0',
});

const store = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'executor-observation-history-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(
    importExecutorObservations({
      dbPath,
      observations: [
        observation('claude-code', '2026-10-25T08:00:00.000Z', '0123456789abcdef'),
        observation('claude-code', '2026-10-25T09:00:00.000Z', 'fedcba9876543210'),
        observation('codex', '2026-10-25T08:30:00.000Z'),
        observation('claude-code', '2026-10-25T10:00:00.000Z', 'fedcba9876543210'),
        observation('codex', '2026-10-25T07:00:00.000Z', undefined),
        // Another machine's rows never enter this machine's history.
        { ...observation('claude-code', '2026-10-25T11:00:00.000Z'), machineId: 'other-machine' },
      ],
    }),
  );
  return dbPath;
};

describe('executor observation history', () => {
  test('lists the retained rows of one machine newest first, per harness when asked, re-validated', async () => {
    const dbPath = await store();
    const all = await Effect.runPromise(queryExecutorObservationHistory({ dbPath, machineId: MACHINE }));
    expect(all.truncated).toBe(false);
    expect(all.skipped).toBe(0);
    expect(
      all.observations.map((entry) => [entry.harness, entry.observedAt, entry.accountFingerprint ?? null]),
    ).toEqual([
      ['claude-code', '2026-10-25T10:00:00.000Z', 'fedcba9876543210'],
      ['claude-code', '2026-10-25T09:00:00.000Z', 'fedcba9876543210'],
      ['codex', '2026-10-25T08:30:00.000Z', null],
      ['claude-code', '2026-10-25T08:00:00.000Z', '0123456789abcdef'],
      ['codex', '2026-10-25T07:00:00.000Z', null],
    ]);

    const claude = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, harness: 'claude-code', machineId: MACHINE }),
    );
    expect(claude.observations.map((entry) => entry.observedAt)).toEqual([
      '2026-10-25T10:00:00.000Z',
      '2026-10-25T09:00:00.000Z',
      '2026-10-25T08:00:00.000Z',
    ]);

    // The latest-per-executor read is unchanged: one row per harness.
    const latest = await Effect.runPromise(queryLatestExecutorObservations({ dbPath, machineId: MACHINE }));
    expect(latest.observations.map((entry) => [entry.harness, entry.observedAt])).toEqual([
      ['claude-code', '2026-10-25T10:00:00.000Z'],
      ['codex', '2026-10-25T08:30:00.000Z'],
    ]);
  });

  test('bounds the read and reports truncation instead of returning more', async () => {
    const dbPath = await store();
    const bounded = await Effect.runPromise(queryExecutorObservationHistory({ dbPath, limit: 2, machineId: MACHINE }));
    expect(bounded.observations).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(MAX_EXECUTOR_OBSERVATION_HISTORY).toBe(640);
    const failure = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, limit: MAX_EXECUTOR_OBSERVATION_HISTORY + 1, machineId: MACHINE }).pipe(
        Effect.flip,
      ),
    );
    expect((failure as UsageStoreError).reason).toBe('invalid-input');
    const zero = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath, limit: 0, machineId: MACHINE }).pipe(Effect.flip),
    );
    expect((zero as UsageStoreError).reason).toBe('invalid-input');
  });
});
