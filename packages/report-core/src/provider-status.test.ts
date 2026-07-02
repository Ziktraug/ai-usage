import { describe, expect, test } from 'bun:test';
import {
  createProviderStatusDataset,
  mergeProviderStatusDatasets,
  normalizeCodexRateLimitStatus,
  normalizeProviderResetCredits,
  parseProviderStatusDataset,
} from './provider-status';

describe('provider status', () => {
  test('normalizes Codex usage payload windows', () => {
    const status = normalizeCodexRateLimitStatus({
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'live-api',
      accountId: 'acct_123',
      rateLimits: {
        plan_type: 'plus',
        rate_limit: {
          credits: 2,
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_at: '2026-01-01T05:00:00.000Z',
          },
          secondary_window: {
            used_percent: 110,
            limit_window_seconds: 604_800,
            reset_at: 'not a date',
            allowed: false,
          },
        },
        additional_rate_limits: [
          {
            limit_name: 'gpt-5-codex',
            rate_limit: {
              primary_window: {
                used_percent: -5,
                limit_window_seconds: 18_000,
                reset_at: '2026-01-01T01:00:00.000Z',
              },
            },
          },
        ],
      },
    });

    expect(status?.key).toBe('codex:acct_123');
    expect(status?.plan).toBe('plus');
    expect(status?.resetCreditsAvailable).toBe(2);
    expect(status?.state).toBe('partial');
    expect(
      status?.windows.map((window) => [window.id, window.label, window.usedPercent, window.group, window.blocked]),
    ).toEqual([
      ['primary', '5h', 25, '5h', false],
      ['secondary', 'Weekly', 100, 'weekly', true],
      ['gpt-5-codex:primary', '5h', 0, 'gpt-5-codex', false],
    ]);
  });

  test('normalizes nested reset credit payloads', () => {
    const credits = normalizeProviderResetCredits(
      {
        rate_limit_reset_credits: {
          available_count: 1,
          credits: [
            {
              title: 'Reset 1',
              status: 'available',
              granted_at: '2026-01-01T00:00:00.000Z',
              expires_at: '2026-01-03T00:00:00.000Z',
            },
            { title: 'Redeemed', status: 'redeemed', expires_at: 'invalid' },
          ],
        },
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(credits).toEqual([
      {
        title: 'Reset 1',
        status: 'available',
        grantedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-03T00:00:00.000Z',
        daysLeft: 2,
      },
      { title: 'Redeemed', status: 'redeemed', grantedAt: null, expiresAt: null, daysLeft: null },
    ]);
  });

  test('parses and merges valid provider status datasets only', () => {
    const older = createProviderStatusDataset(
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
    const newer = createProviderStatusDataset(
      [{ ...older.providers[0]!, generatedAt: '2026-01-02T00:00:00.000Z', state: 'stale' }],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(parseProviderStatusDataset({ schemaVersion: 1, providers: [] })).toBeNull();
    expect(mergeProviderStatusDatasets([older, newer])?.providers[0]?.state).toBe('stale');
  });
});
