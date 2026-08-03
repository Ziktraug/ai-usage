import { describe, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { harnessProviderView, providerDisclosureId } from './harness-provider-model';

const group = (key: string, harness = key, provider = key, sessions = 1): AnalyticsGroup => ({
  ambiguous: 0,
  cache: 0,
  cacheHitPct: 0,
  costPer100Lines: null,
  costPercent: 0,
  costPerSession: null,
  costSum: sessions,
  fresh: sessions,
  harness,
  inp: sessions,
  key,
  lineCount: 0,
  linesA: 0,
  linesD: 0,
  medianCost: null,
  priced: sessions,
  provider,
  sessions,
  tools: 0,
  turns: 0,
  unpriced: 0,
  unpricedFreshTokens: 0,
  usageUnavailable: 0,
});

describe('harness/provider hierarchy projection', () => {
  test('keeps children collapsed while counting every pair and exporting only visible rows', () => {
    const view = harnessProviderView(
      [group('claude'), group('codex')],
      [group('z-provider', 'claude', 'z-provider'), group('a-provider', 'claude', 'a-provider')],
      '',
      'value',
      [],
    );

    expect(view.pairCount).toBe(2);
    expect(view.parents.find(({ group: parent }) => parent.key === 'claude')?.children).toEqual([]);
    expect(view.exportRows.map(({ label }) => label)).toEqual(['claude', 'codex']);
  });

  test('sorts expanded providers by sessions then key and includes them in the visible export', () => {
    const view = harnessProviderView(
      [group('claude')],
      [
        group('z-provider', 'claude', 'z-provider', 2),
        group('a-provider', 'claude', 'a-provider', 2),
        group('largest', 'claude', 'largest', 3),
      ],
      '',
      'value',
      ['claude'],
    );

    expect(view.parents[0]?.children.map(({ label }) => label)).toEqual(['largest', 'a-provider', 'z-provider']);
    expect(view.exportRows.map(({ label }) => label)).toEqual(['claude', 'largest', 'a-provider', 'z-provider']);
  });

  test('searches provider labels, expands matching children, and exposes a stable encoded disclosure id', () => {
    const view = harnessProviderView(
      [group('claude/code')],
      [group('anthropic', 'claude/code', 'Anthropic'), group('other', 'claude/code', 'Other')],
      'anthro',
      'sessions',
      [],
    );

    expect(view.searchActive).toBe(true);
    expect(view.parents[0]?.children.map(({ label }) => label)).toEqual(['Anthropic']);
    expect(view.pairCount).toBe(1);
    expect(view.parents[0]?.controlsId).toBe(providerDisclosureId('claude/code'));
  });
});
