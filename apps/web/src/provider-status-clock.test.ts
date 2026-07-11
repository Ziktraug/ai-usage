import { describe, expect, test } from 'bun:test';
import { createProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { createRoot } from 'solid-js';
import { createProviderStatusClock } from './provider-status-clock';
import { buildProviderStatusViews } from './provider-status-model';

const reportPayload = (): UsageReportPayload => {
  const providerStatus = createProviderStatusDataset(
    [
      {
        generatedAt: '2026-01-01T00:00:00.000Z',
        key: 'codex',
        label: 'Codex',
        source: 'live-api',
        state: 'ok',
        windows: [
          {
            blocked: false,
            group: '5h',
            id: 'primary',
            label: '5h',
            limitSeconds: 18_000,
            remainingPercent: 75,
            resetsAt: '2026-01-01T00:10:00.000Z',
            scope: 'global',
            usedPercent: 25,
          },
        ],
      },
    ],
    new Date('2026-01-01T00:00:00.000Z'),
  );
  return {
    analytics: {} as UsageReportPayload['analytics'],
    datasets: { providerStatus },
    filters: { since: null, project: null, limit: null, minTokens: 1, sort: 'date' },
    generatedAt: '2026-01-01T00:05:00.000Z',
    omittedRows: 0,
    rows: [],
    tableRows: [],
  };
};

describe('provider status clock', () => {
  test('ages provider status and reset windows without replacing the report payload', () => {
    const payload = reportPayload();
    let currentTime = payload.generatedAt;
    let scheduledTick: (() => void) | null = null;
    let schedulerCleanedUp = false;

    createRoot((dispose) => {
      const clock = createProviderStatusClock({
        initialNow: payload.generatedAt,
        readNow: () => currentTime,
        schedule: (tick) => {
          scheduledTick = tick;
          return () => {
            schedulerCleanedUp = true;
          };
        },
      });
      const views = () => buildProviderStatusViews(payload, [], clock.now());

      expect(views()[0]).toMatchObject({
        nextResetAt: '2026-01-01T00:10:00.000Z',
        provider: { state: 'ok' },
      });

      clock.start();
      currentTime = '2026-01-01T00:20:00.000Z';
      if (!scheduledTick) {
        throw new Error('Provider status clock did not schedule a tick');
      }
      scheduledTick();

      expect(views()[0]).toMatchObject({
        nextResetAt: null,
        provider: { state: 'stale' },
      });

      dispose();
    });

    expect(schedulerCleanedUp).toBe(true);
  });
});
