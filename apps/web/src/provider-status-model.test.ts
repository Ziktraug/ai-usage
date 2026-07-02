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
      ['codex', 'ok'],
      ['claude', 'unsupported'],
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

  test('falls back to legacy facets when canonical provider status is malformed', () => {
    const providerStatus = createProviderStatusDataset(
      [
        {
          key: 'codex',
          label: 'Codex',
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: 'local-history',
          state: 'ok',
          windows: [],
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const views = buildProviderStatusViews(
      payload({
        datasets: { providerStatus: { schemaVersion: 1 } as unknown as never },
        facets: { providerStatus },
      }),
      [],
    );

    expect(views.map((view) => view.provider.key)).toEqual(['codex']);
  });

  test('explicit provider status only suppresses inferred rows for the same machine scope', () => {
    const providerStatus = createProviderStatusDataset(
      [
        {
          key: 'codex',
          label: 'Codex',
          generatedAt: '2026-01-01T00:00:00.000Z',
          machineId: 'Laptop',
          machineLabel: 'Laptop',
          source: 'local-history',
          state: 'ok',
          windows: [],
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const views = buildProviderStatusViews(payload({ datasets: { providerStatus } }), [
      row({ harness: 'Codex', provider: 'Codex sub', machine: 'Laptop' }),
      row({ harness: 'Codex', provider: 'Codex sub', machine: 'Workstation' }),
    ]);

    expect(views.map((view) => [view.provider.key, view.machineContext]).sort()).toEqual([
      ['codex', 'Laptop'],
      ['codex', 'Workstation'],
    ]);
  });

  test('summarizes reset credits with the earliest expiry', () => {
    const providerStatus = createProviderStatusDataset(
      [
        {
          key: 'codex',
          label: 'Codex',
          generatedAt: '2026-01-01T00:00:00.000Z',
          resetCredits: [
            {
              daysLeft: 3,
              expiresAt: '2026-01-04T00:00:00.000Z',
              grantedAt: null,
              status: 'available',
              title: 'Later',
            },
            {
              daysLeft: 1,
              expiresAt: '2026-01-02T00:00:00.000Z',
              grantedAt: null,
              status: 'available',
              title: 'Sooner',
            },
          ],
          resetCreditsAvailable: 2,
          source: 'live-api',
          state: 'ok',
          windows: [],
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const views = buildProviderStatusViews(payload({ datasets: { providerStatus } }), []);

    expect(views[0]?.creditsSummary).toContain('2 reset credits');
    expect(views[0]?.creditsSummary).toContain('expires');
  });
});
