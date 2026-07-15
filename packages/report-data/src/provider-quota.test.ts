import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaBatchSource } from '@ai-usage/local-collectors';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { queryLocalProviderQuotaHistory, refreshLocalProviderQuotas } from './provider-quota';

const observation = (observedAt: string): ProviderQuotaObservation => ({
  accountScope: null,
  machineId: 'machine-1',
  machineLabel: 'Laptop',
  observedAt,
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'codex:primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 75,
      resetsAt: '2026-07-15T15:00:00.000Z',
      scope: 'provider',
      usedPercent: 25,
    },
  ],
});

describe('provider quota orchestration', () => {
  test('polls once per cadence and exposes independently bounded history', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-report-quota-'));
    const dbPath = usageStorePath(home);
    const run = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));
    let calls = 0;
    const liveSource: ProviderQuotaBatchSource = {
      collect: (request) => {
        calls++;
        return Effect.succeed({
          checkpoints: [],
          hasMore: false,
          observations: [observation((request.observedAt ?? new Date()).toISOString())],
          sourceEvents: [],
        });
      },
    };

    const input = {
      dbPath,
      machine: { id: 'machine-1', label: 'Laptop' },
      options: {
        backfillSource: null,
        liveSource,
        now: () => new Date('2026-07-15T10:00:00.000Z'),
      },
    } as const;
    const first = await run(refreshLocalProviderQuotas(input));
    const second = await run(refreshLocalProviderQuotas(input));
    const history = await run(
      queryLocalProviderQuotaHistory({
        dbPath,
        from: '2026-07-15T09:00:00.000Z',
        machineId: 'machine-1',
        maximumPoints: 10,
        providerKey: 'codex',
        to: '2026-07-15T11:00:00.000Z',
      }),
    );

    expect(first.live).toBe('refreshed');
    expect(second.live).toBe('skipped');
    expect(calls).toBe(1);
    expect(history.points).toHaveLength(1);
    expect(history.latest[0]?.source).toBe('live-api');
  });
});
