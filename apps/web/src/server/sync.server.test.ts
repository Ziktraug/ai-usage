import { expect, test } from 'bun:test';
import { USAGE_MERGE_BUNDLE_VERSION, type UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import { UsageStoreError } from '@ai-usage/usage-store/reader';
import { exportManualMergeBundleForServer, getSyncFleetForServer } from './sync-data.server';
import type { UsageReadModel } from './usage-read-model.server';

const bundle: UsageMergeBundle = {
  generatedAt: '2026-07-30T12:34:56.789Z',
  machine: { id: 'studio-id', label: 'Studio Mac' },
  rows: [],
  version: USAGE_MERGE_BUNDLE_VERSION,
  warnings: [],
};

const readModel = (overrides: Partial<UsageReadModel>): UsageReadModel => ({
  queryRevision: () => Promise.reject(new Error('Unexpected revision query')),
  readCurrentBootstrap: () => Promise.reject(new Error('Unexpected bootstrap query')),
  readCurrentLocalProjectSources: () => Promise.reject(new Error('Unexpected source query')),
  readCurrentManifest: () => Promise.reject(new Error('Unexpected manifest query')),
  readLatestProviderQuota: () => Promise.reject(new Error('Unexpected provider quota query')),
  readLocalMergeBundle: () => Promise.resolve(bundle),
  readLocalMachine: () => Promise.resolve(bundle.machine),
  readSyncFleet: () =>
    Promise.resolve({
      currentMachine: bundle.machine,
      machines: [],
      omittedMachines: 0,
      skipped: 0,
    }),
  ...overrides,
});

test('reads Sync fleet directly from the injected read-only model', async () => {
  const result = await getSyncFleetForServer(readModel({}));

  expect(result).toEqual({
    data: { currentMachine: bundle.machine, machines: [], omittedMachines: 0, skipped: 0 },
    ok: true,
  });
});

test('exports the canonical exact merge text and preserves the filename convention', async () => {
  const result = await exportManualMergeBundleForServer(readModel({}));

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.data).toMatchObject({
    bytes: new TextEncoder().encode(result.data.text).byteLength,
    filename: 'ai-usage-studio-mac-2026-07-30T12-34-56-789Z.json',
    machine: bundle.machine,
    rows: 0,
  });
  expect(result.data.text.endsWith('\n')).toBe(true);
  expect(JSON.parse(result.data.text)).toEqual(bundle);
});

test('sanitizes reader failures without exposing the SQLite path', async () => {
  const failure = new UsageStoreError({
    message: 'Could not read /private/home/.config/ai-usage/usage.sqlite',
    operation: 'queryUsageSyncFleet',
    reason: 'store-missing',
  });
  const result = await getSyncFleetForServer(readModel({ readSyncFleet: () => Promise.reject(failure) }));

  expect(result).toEqual({
    error: {
      message: 'No durable usage data is available yet.',
      reason: 'store-missing',
      tag: 'UsageStoreReadError',
    },
    ok: false,
  });
  expect(JSON.stringify(result)).not.toContain('/private/home');
});
