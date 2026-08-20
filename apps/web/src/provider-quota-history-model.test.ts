import { describe, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryPoint, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { buildProviderQuotaHistoryModel } from './provider-quota-history-model';

const point = (
  input: Partial<ProviderQuotaHistoryPoint> & Pick<ProviderQuotaHistoryPoint, 'firstObservedAt' | 'usedPercent'>,
): ProviderQuotaHistoryPoint => ({
  accountScope: null,
  blocked: false,
  group: '5h',
  lastObservedAt: input.firstObservedAt,
  limitSeconds: 18_000,
  machineId: 'machine-1',
  machineLabel: 'Laptop',
  providerKey: 'codex',
  providerLabel: 'Codex',
  resetAt: '2026-07-15T15:00:00.000Z',
  source: { confidence: 'historical', key: 'codex-rollout', mode: 'backfill' },
  windowId: 'codex:primary',
  windowLabel: '5h',
  ...input,
});

test('groups provider-defined windows and describes reset and gap boundaries', () => {
  const points = [
    point({ firstObservedAt: '2026-07-15T10:00:00.000Z', usedPercent: 20 }),
    point({ firstObservedAt: '2026-07-15T10:05:00.000Z', usedPercent: 30 }),
    point({ firstObservedAt: '2026-07-15T10:30:00.000Z', usedPercent: 40 }),
    point({
      firstObservedAt: '2026-07-15T10:35:00.000Z',
      resetAt: '2026-07-15T20:00:00.000Z',
      usedPercent: 5,
    }),
    point({
      firstObservedAt: '2026-07-15T10:35:00.000Z',
      source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
      resetAt: '2026-07-15T20:00:00.000Z',
      usedPercent: 6,
    }),
  ];
  const result: ProviderQuotaHistoryResult = {
    coverage: [],
    generatedAt: '2026-07-15T10:36:00.000Z',
    latest: [],
    points,
    skipped: 0,
    truncated: false,
  };

  const model = buildProviderQuotaHistoryModel(result);

  expect(model.series).toHaveLength(1);
  expect(model.series[0]?.points.map(({ usedPercent }) => usedPercent)).toEqual([20, 30, 40, 6]);
  expect(model.series[0]?.gapCount).toBe(1);
  expect(model.series[0]?.resetCount).toBe(1);
  expect(model.series[0]?.summary).toContain('1 reset');
  expect(model.series[0]?.summary).toContain('1 collection gap');
});

test('keeps a series per provider when two providers report the same window', () => {
  const points = [
    point({ firstObservedAt: '2026-07-15T10:00:00.000Z', usedPercent: 20 }),
    point({ firstObservedAt: '2026-07-15T10:05:00.000Z', usedPercent: 30 }),
    point({
      firstObservedAt: '2026-07-15T10:00:00.000Z',
      providerKey: 'claude',
      providerLabel: 'Claude',
      source: { confidence: 'authoritative', key: 'claude-agent-sdk', mode: 'poll' },
      usedPercent: 11,
      windowId: 'claude:primary',
    }),
    point({
      firstObservedAt: '2026-07-15T10:05:00.000Z',
      providerKey: 'claude',
      providerLabel: 'Claude',
      source: { confidence: 'authoritative', key: 'claude-agent-sdk', mode: 'poll' },
      usedPercent: 17,
      windowId: 'claude:primary',
    }),
  ];

  const model = buildProviderQuotaHistoryModel({
    coverage: [],
    generatedAt: '2026-07-15T10:06:00.000Z',
    latest: [],
    points,
    skipped: 0,
    truncated: false,
  });

  expect(model.series).toHaveLength(2);
  expect(model.series.map(({ providerKey }) => providerKey).sort()).toEqual(['claude', 'codex']);
  const claude = model.series.find(({ providerKey }) => providerKey === 'claude');
  const codex = model.series.find(({ providerKey }) => providerKey === 'codex');
  expect(claude?.providerLabel).toBe('Claude');
  expect(claude?.points.map(({ usedPercent }) => usedPercent)).toEqual([11, 17]);
  expect(codex?.providerLabel).toBe('Codex');
  expect(codex?.points.map(({ usedPercent }) => usedPercent)).toEqual([20, 30]);
});

describe('empty history', () => {
  test('returns a stable empty state without fabricating monthly windows', () => {
    const model = buildProviderQuotaHistoryModel({
      coverage: [],
      generatedAt: '2026-07-15T10:36:00.000Z',
      latest: [],
      points: [],
      skipped: 0,
      truncated: false,
    });
    expect(model.series).toEqual([]);
    expect(model.emptyMessage).toBe('No quota history yet.');
  });
});
