import { describe, expect, test } from 'bun:test';
import { createProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { buildProviderStatusViews } from './provider-status-model';
import type { DashboardRow } from './shared';

const payload = (overrides: Partial<UsageReportPayload> = {}): UsageReportPayload =>
  ({
    generatedAt: '2026-01-01T00:00:00.000Z',
    rows: [],
    tableRows: [],
    omittedRows: 0,
    filters: { since: null, project: null, limit: null, minTokens: 1, sort: 'date' },
    analytics: {} as UsageReportPayload['analytics'],
    ...overrides,
  }) satisfies UsageReportPayload;

const row = (input: { harness: string; provider: string; machine?: string }): DashboardRow =>
  ({
    harness: input.harness,
    provider: input.provider,
    providerDisplay: input.provider,
    source: input.machine
      ? { machineId: input.machine, machineLabel: input.machine, harnessKey: input.harness }
      : undefined,
  }) as DashboardRow;

describe('provider status model', () => {
  test('uses explicit provider status dataset and infers missing providers from usage rows', () => {
    const providerStatus = createProviderStatusDataset(
      [
        {
          key: 'codex',
          label: 'Codex',
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: 'local-history',
          state: 'ok',
          windows: [
            {
              id: 'primary',
              label: '5h',
              blocked: false,
              group: '5h',
              limitSeconds: 18_000,
              remainingPercent: 30,
              resetsAt: '2026-01-01T05:00:00.000Z',
              scope: 'global',
              usedPercent: 70,
            },
          ],
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const views = buildProviderStatusViews(payload({ datasets: { providerStatus } }), [
      row({ harness: 'Codex', provider: 'Codex sub' }),
      row({ harness: 'Claude', provider: 'Claude sub' }),
    ]);

    expect(views.map((view) => [view.provider.key, view.provider.state])).toEqual([
      ['claude', 'unsupported'],
      ['codex', 'ok'],
    ]);
    expect(views.find((view) => view.provider.key === 'codex')?.windowGroups[0]?.key).toBe('5h');
  });

  test('ignores malformed datasets without hiding inferred provider rows', () => {
    const views = buildProviderStatusViews(
      payload({ datasets: { providerStatus: { schemaVersion: 1 } as unknown as never } }),
      [row({ harness: 'Cursor', provider: 'Cursor local', machine: 'Laptop' })],
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.provider).toMatchObject({ key: 'cursor', state: 'partial', machineLabel: 'Laptop' });
  });
});
