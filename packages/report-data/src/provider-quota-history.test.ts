import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { importProviderQuotaBatch } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { queryProviderQuotaHistory } from './provider-quota-history';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const QUOTA_FIRST_SIGHTING = '2026-07-30T08:00:00.000Z';
const QUOTA_CONFIRMATION = '2026-07-30T08:20:00.000Z';
const QUOTA_READ_AT = new Date('2026-07-30T08:22:00.000Z');

const liveQuotaReading = (observedAt: string): ProviderQuotaObservation => ({
  accountScope: null,
  machineId: 'machine-a',
  machineLabel: 'Machine A',
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
      resetsAt: '2026-07-30T12:00:00.000Z',
      scope: 'provider',
      usedPercent: 25,
    },
  ],
});

const storeWithLiveQuotaReadings = async (observedAts: readonly string[]) => {
  const root = await mkdtemp(path.join(tmpdir(), 'report-data-provider-quota-history-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  const imports = await Effect.runPromise(
    Effect.forEach(observedAts, (observedAt, index) =>
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [{ observation: liveQuotaReading(observedAt), sourceEventKey: `live-${index}` }],
      }),
    ),
  );
  return { dbPath, imports };
};

describe('provider quota history read', () => {
  test('dates the latest coalesced reading by its last confirmation while points keep both bounds', async () => {
    const { dbPath, imports } = await storeWithLiveQuotaReadings([QUOTA_FIRST_SIGHTING, QUOTA_CONFIRMATION]);
    // The confirmation must merge into the first sighting's row, or there is nothing to date by it.
    expect(imports).toMatchObject([{ inserted: 1 }, { coalesced: 1, inserted: 0 }]);

    const history = await Effect.runPromise(
      queryProviderQuotaHistory({
        dbPath,
        from: '2026-07-30T07:00:00.000Z',
        now: () => QUOTA_READ_AT,
        to: QUOTA_READ_AT.toISOString(),
      }),
    );

    expect(history.latest).toMatchObject([
      { generatedAt: QUOTA_CONFIRMATION, key: 'codex', source: 'live-api', state: 'ok' },
    ]);
    expect(history.points).toMatchObject([
      {
        firstObservedAt: QUOTA_FIRST_SIGHTING,
        lastObservedAt: QUOTA_CONFIRMATION,
        machineId: 'machine-a',
        providerKey: 'codex',
        windowId: 'codex:primary',
      },
    ]);
    expect(history.generatedAt).toBe(QUOTA_READ_AT.toISOString());
  });
});
