import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { Effect } from 'effect';
import { queryLatestProviderQuotaObservations, queryProviderQuotaObservations } from './reader';
import { importProviderQuotaBatch, retainProviderQuotaObservations } from './writer';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-01T00:00:00.000Z');

const streamObservation = (observedAt: string, usedPercent: number): ProviderQuotaObservation => ({
  accountScope: 'account-a',
  machineId: 'machine-a',
  machineLabel: 'Machine A',
  observedAt,
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: 'source-a', mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'codex:primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 100 - usedPercent,
      resetsAt: '2026-07-15T15:00:00.000Z',
      scope: 'provider',
      usedPercent,
    },
  ],
});

const createStore = async (observedAts: readonly string[]): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-quota-retention-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: observedAts.map((observedAt, index) => ({
        observation: streamObservation(observedAt, index + 1),
        sourceEventKey: `event-${index}`,
      })),
    }),
  );
  return dbPath;
};

const observedRange = (dbPath: string) =>
  Effect.runPromise(
    queryProviderQuotaObservations({
      dbPath,
      from: '2020-01-01T00:00:00.000Z',
      to: '2030-01-01T00:00:00.000Z',
    }),
  );

describe('provider quota retention', () => {
  test('downsamples stale observations to one per stream and hour while preserving the latest head', async () => {
    const dbPath = await createStore([
      // Two hour buckets, both far beyond the 90-day full-resolution window.
      '2026-01-10T10:00:00.000Z',
      '2026-01-10T10:20:00.000Z',
      '2026-01-10T10:40:00.000Z',
      '2026-01-10T11:00:00.000Z',
      '2026-01-10T11:30:00.000Z',
    ]);

    const result = await Effect.runPromise(retainProviderQuotaObservations({ dbPath, now: NOW }));

    // 10:00 and 11:00 survive as bucket keepers; 11:30 survives as the latest head.
    expect(result.deleted).toBe(2);
    const history = await observedRange(dbPath);
    expect(history.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual([
      '2026-01-10T10:00:00.000Z',
      '2026-01-10T11:00:00.000Z',
      '2026-01-10T11:30:00.000Z',
    ]);
    const latest = await Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath }));
    expect(latest.observations.map(({ firstObservedAt }) => firstObservedAt)).toEqual(['2026-01-10T11:30:00.000Z']);
  });

  test('keeps every observation inside the full-resolution window', async () => {
    const within = new Date(NOW - 5 * DAY_MS).toISOString();
    const alsoWithin = new Date(NOW - 5 * DAY_MS + 10 * 60 * 1000).toISOString();
    const dbPath = await createStore([within, alsoWithin]);

    const result = await Effect.runPromise(retainProviderQuotaObservations({ dbPath, now: NOW }));

    expect(result.deleted).toBe(0);
    const history = await observedRange(dbPath);
    expect(history.observations).toHaveLength(2);
  });

  test('rejects invalid retention options', async () => {
    const dbPath = await createStore(['2026-01-10T10:00:00.000Z']);

    await expect(
      Effect.runPromise(retainProviderQuotaObservations({ dbPath, fullResolutionMs: 0, now: NOW })),
    ).rejects.toThrow('invalid');
  });
});
