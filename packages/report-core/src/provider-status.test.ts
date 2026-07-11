import { describe, expect, test } from 'bun:test';
import {
  createProviderStatusDataset,
  mergeProviderStatusDatasets,
  normalizeCodexRateLimitStatus,
  normalizeProviderResetCredits,
  type ProviderLimitWindow,
  type ProviderResetCredit,
  type ProviderStatus,
  parseProviderStatusDataset,
} from './provider-status';

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';

const providerStatusFixture = (overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  generatedAt: FIXTURE_GENERATED_AT,
  key: 'codex',
  label: 'Codex',
  source: 'live-api',
  state: 'ok',
  windows: [],
  ...overrides,
});

const providerWindowFixture = (overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow => ({
  blocked: false,
  group: '5h',
  id: 'primary',
  label: '5h',
  limitSeconds: 18_000,
  remainingPercent: 75,
  resetsAt: '2026-01-01T05:00:00.000Z',
  scope: 'global',
  usedPercent: 25,
  ...overrides,
});

const providerResetCreditFixture = (overrides: Partial<ProviderResetCredit> = {}): ProviderResetCredit => ({
  daysLeft: 1,
  expiresAt: '2026-01-02T00:00:00.000Z',
  grantedAt: FIXTURE_GENERATED_AT,
  status: 'available',
  title: 'Reset',
  ...overrides,
});

const providerStatusDatasetFixture = (provider = providerStatusFixture()) =>
  createProviderStatusDataset([provider], new Date(FIXTURE_GENERATED_AT));

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

  test('interprets WHAM reset_at epochs as Unix seconds and preserves ISO timestamps', () => {
    const status = normalizeCodexRateLimitStatus({
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'live-api',
      rateLimits: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_at: 1_767_243_600,
        },
        secondary_window: {
          used_percent: 50,
          limit_window_seconds: 604_800,
          reset_at: '1767247200',
        },
        additional_rate_limits: [
          {
            limit_name: 'gpt-5-codex',
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_at: '2026-01-01T07:00:00.000Z',
              },
            },
          },
        ],
      },
    });

    expect(status?.windows.map((window) => window.resetsAt)).toEqual([
      '2026-01-01T05:00:00.000Z',
      '2026-01-01T06:00:00.000Z',
      '2026-01-01T07:00:00.000Z',
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
    const olderProvider = providerStatusFixture({ source: 'local-history' });
    const older = providerStatusDatasetFixture(olderProvider);
    const newer = createProviderStatusDataset(
      [{ ...olderProvider, generatedAt: '2026-01-02T00:00:00.000Z', state: 'stale' }],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(parseProviderStatusDataset({ schemaVersion: 1, providers: [] })).toBeNull();
    expect(mergeProviderStatusDatasets([older, newer])?.providers[0]?.state).toBe('stale');
  });

  test('rejects malformed reset-credit collections', () => {
    const provider = providerStatusFixture({ resetCredits: [] });
    const dataset = providerStatusDatasetFixture(provider);

    expect(
      parseProviderStatusDataset({
        ...dataset,
        providers: [{ ...provider, resetCredits: {} }],
      }),
    ).toBeNull();
  });

  test('rejects provider states inherited from Object.prototype', () => {
    const provider = providerStatusFixture();
    const dataset = providerStatusDatasetFixture(provider);

    expect(
      parseProviderStatusDataset({
        ...dataset,
        providers: [{ ...provider, state: '__proto__' }],
      }),
    ).toBeNull();
  });

  test('requires a recognized provider-status source', () => {
    const provider = providerStatusFixture();
    const dataset = providerStatusDatasetFixture(provider);
    const { source: _, ...providerWithoutSource } = provider;

    expect(
      parseProviderStatusDataset({
        ...dataset,
        providers: [providerWithoutSource],
      }),
    ).toBeNull();
  });

  test('requires a recognized scope for every quota window', () => {
    const window = providerWindowFixture();
    const provider = providerStatusFixture({ windows: [window] });
    const dataset = providerStatusDatasetFixture(provider);
    const { scope: _, ...windowWithoutScope } = window;

    expect(
      parseProviderStatusDataset({
        ...dataset,
        providers: [{ ...provider, windows: [windowWithoutScope] }],
      }),
    ).toBeNull();
  });

  test('rejects invalid timestamps throughout the serialized dataset', () => {
    const resetCredit = providerResetCreditFixture();
    const window = providerWindowFixture();
    const provider = providerStatusFixture({ resetCredits: [resetCredit], windows: [window] });
    const dataset = providerStatusDatasetFixture(provider);
    const invalidDatasets = [
      { ...dataset, generatedAt: 'invalid' },
      { ...dataset, providers: [{ ...provider, generatedAt: 'invalid' }] },
      {
        ...dataset,
        providers: [{ ...provider, windows: [{ ...window, resetsAt: 'invalid' }] }],
      },
      {
        ...dataset,
        providers: [{ ...provider, resetCredits: [{ ...resetCredit, grantedAt: 'invalid' }] }],
      },
      {
        ...dataset,
        providers: [{ ...provider, resetCredits: [{ ...resetCredit, expiresAt: 'invalid' }] }],
      },
    ];

    expect(invalidDatasets.map(parseProviderStatusDataset)).toEqual([null, null, null, null, null]);
  });

  test('accepts complete RFC3339 timestamps and rejects ambiguous or calendar-normalized dates', () => {
    const offsetTimestamp = '2026-01-01T01:00:00+01:00';
    const provider = providerStatusFixture({ generatedAt: offsetTimestamp });
    const validDataset = {
      ...providerStatusDatasetFixture(provider),
      generatedAt: offsetTimestamp,
    };

    expect(parseProviderStatusDataset(validDataset)).not.toBeNull();

    const invalidTimestamps = ['0', '2026-01-01', '2026-02-31T00:00:00.000Z'];
    expect(
      invalidTimestamps.map((generatedAt) =>
        parseProviderStatusDataset({
          ...validDataset,
          generatedAt,
          providers: [{ ...provider, generatedAt }],
        }),
      ),
    ).toEqual([null, null, null]);
  });

  test('rejects non-finite and out-of-range serialized numbers', () => {
    const resetCredit = providerResetCreditFixture();
    const window = providerWindowFixture();
    const provider = providerStatusFixture({
      resetCredits: [resetCredit],
      resetCreditsAvailable: 1,
      windows: [window],
    });
    const dataset = providerStatusDatasetFixture(provider);
    const withWindowNumber = (field: string, value: number) => ({
      ...dataset,
      providers: [{ ...provider, windows: [{ ...window, [field]: value }] }],
    });
    const invalidDatasets = [
      withWindowNumber('usedPercent', Number.NaN),
      withWindowNumber('usedPercent', -1),
      withWindowNumber('usedPercent', 101),
      withWindowNumber('remainingPercent', Number.POSITIVE_INFINITY),
      withWindowNumber('remainingPercent', -1),
      withWindowNumber('remainingPercent', 101),
      withWindowNumber('limitSeconds', Number.POSITIVE_INFINITY),
      withWindowNumber('limitSeconds', 0),
      {
        ...dataset,
        providers: [{ ...provider, resetCreditsAvailable: -1 }],
      },
      {
        ...dataset,
        providers: [{ ...provider, resetCredits: [{ ...resetCredit, daysLeft: Number.POSITIVE_INFINITY }] }],
      },
    ];

    expect(invalidDatasets.every((value) => parseProviderStatusDataset(value) === null)).toBe(true);
  });

  test('rejects incorrectly typed optional provider fields', () => {
    const resetCredit = providerResetCreditFixture();
    const provider = providerStatusFixture({ resetCredits: [resetCredit] });
    const dataset = providerStatusDatasetFixture(provider);
    const withProviderField = (field: string, value: unknown) => ({
      ...dataset,
      providers: [{ ...provider, [field]: value }],
    });
    const invalidDatasets = [
      withProviderField('accountLabel', 1),
      withProviderField('creditsBalance', 1),
      withProviderField('plan', []),
      withProviderField('machineId', null),
      withProviderField('machineLabel', {}),
      withProviderField('warnings', 'collection failed'),
      withProviderField('warnings', ['safe warning', 1]),
      {
        ...dataset,
        providers: [{ ...provider, resetCredits: [{ ...resetCredit, title: null }] }],
      },
      {
        ...dataset,
        providers: [{ ...provider, resetCredits: [{ ...resetCredit, status: 1 }] }],
      },
    ];

    expect(invalidDatasets.every((value) => parseProviderStatusDataset(value) === null)).toBe(true);
  });

  test('rejects empty provider and machine identity strings before multi-machine merge', () => {
    const provider = providerStatusFixture();
    const dataset = providerStatusDatasetFixture(provider);
    const invalidDatasets = [
      { ...dataset, providers: [{ ...provider, key: '' }] },
      { ...dataset, providers: [{ ...provider, label: '   ' }] },
      { ...dataset, providers: [{ ...provider, machineId: '' }] },
      { ...dataset, providers: [{ ...provider, machineLabel: '   ' }] },
    ];

    expect(invalidDatasets.every((value) => parseProviderStatusDataset(value) === null)).toBe(true);

    const machineA = providerStatusDatasetFixture(providerStatusFixture({ machineId: 'machine-a' }));
    const machineB = providerStatusDatasetFixture(providerStatusFixture({ machineId: 'machine-b' }));
    expect(mergeProviderStatusDatasets([machineA, machineB])?.providers.map((entry) => entry.machineId)).toEqual([
      'machine-a',
      'machine-b',
    ]);
  });

  test('rejects empty quota-window identity and warning strings', () => {
    const window = providerWindowFixture();
    const provider = providerStatusFixture({ warnings: ['Collection delayed'], windows: [window] });
    const dataset = providerStatusDatasetFixture(provider);
    const invalidDatasets = [
      { ...dataset, providers: [{ ...provider, windows: [{ ...window, id: '' }] }] },
      { ...dataset, providers: [{ ...provider, windows: [{ ...window, label: '   ' }] }] },
      { ...dataset, providers: [{ ...provider, windows: [{ ...window, group: '' }] }] },
      { ...dataset, providers: [{ ...provider, warnings: ['Collection delayed', '   '] }] },
    ];

    expect(invalidDatasets.every((value) => parseProviderStatusDataset(value) === null)).toBe(true);
  });
});
