import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { importProviderQuotaBatch, initializeUsageStore } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { getProviderQuotaHistoryForServer } from './provider-quota.server';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const observation: ProviderQuotaObservation = {
  accountScope: null,
  machineId: 'machine-a',
  machineLabel: 'Laptop',
  observedAt: '2026-07-30T10:00:00.000Z',
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
      resetsAt: '2026-07-30T15:00:00.000Z',
      scope: 'provider',
      usedPercent: 25,
    },
  ],
};

test('reads provider quota history directly from an isolated query-only store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wave4-web-provider-quota-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      importedAt: new Date('2026-07-30T10:00:00.000Z'),
      items: [{ observation }],
    }),
  );

  const result = await getProviderQuotaHistoryForServer(
    {
      from: '2026-07-30T09:00:00.000Z',
      machineId: 'machine-a',
      maximumPoints: 10,
      providerKey: 'codex',
      to: '2026-07-30T11:00:00.000Z',
    },
    { dbPath, now: () => new Date('2026-07-30T12:00:00.000Z') },
  );

  expect(result).toMatchObject({
    generatedAt: '2026-07-30T12:00:00.000Z',
    latest: [{ key: 'codex' }],
    points: [{ machineId: 'machine-a', usedPercent: 25 }],
  });
});

test('does not create a missing store or expose its private path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wave4-web-provider-quota-missing-'));
  roots.push(root);
  const dbPath = path.join(root, 'missing', 'usage.sqlite');

  try {
    await getProviderQuotaHistoryForServer(
      { from: '2026-07-30T09:00:00.000Z', to: '2026-07-30T11:00:00.000Z' },
      { dbPath },
    );
    throw new Error('Expected provider quota history to be unavailable.');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').toBe('Provider quota history is unavailable.');
    expect(error instanceof Error ? error.message : '').not.toContain(root);
  }
  expect(await Bun.file(dbPath).exists()).toBe(false);
});
