import { describe, expect, test } from 'bun:test';
import { provenanceForMetric, provenanceForUsageRow } from './provenance';
import type { Row } from './types';

const row = (overrides: Partial<Row> = {}): Row => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: 'fixture',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 100,
  tokOut: 50,
  tokCr: 0,
  tokCw: 0,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 2,
  linesAdded: 1,
  linesDeleted: 0,
  titleSource: 'ai',
  ...overrides,
});

describe('usage row provenance', () => {
  test('marks non-ai titles as derived title provenance', () => {
    expect(provenanceForMetric(row({ titleSource: 'first-prompt' }), 'title').map((item) => item.kind)).toEqual([
      'title-derived',
    ]);
    expect(provenanceForMetric(row({ titleSource: 'ai' }), 'title')).toEqual([]);
  });

  test('usageUnavailable applies to unavailable usage metrics but not turns', () => {
    const provenance = provenanceForUsageRow(row({ usageUnavailable: true }));
    const usageUnavailable = provenance.find((item) => item.kind === 'usage-unavailable');

    expect(usageUnavailable?.appliesTo).toContain('tokens');
    expect(usageUnavailable?.appliesTo).toContain('api-value');
    expect(usageUnavailable?.appliesTo).toContain('actual-cost');
    expect(usageUnavailable?.appliesTo).toContain('subscription-value');
    expect(usageUnavailable?.appliesTo).toContain('calls');
    expect(usageUnavailable?.appliesTo).toContain('tools');
    expect(usageUnavailable?.appliesTo).not.toContain('turns');
  });

  test('partial and ambiguous provenance apply to counters and aggregates but not title', () => {
    expect(provenanceForMetric(row({ partial: true }), 'turns').map((item) => item.kind)).toEqual(['partial-session']);
    expect(provenanceForMetric(row({ ambiguous: true }), 'lines').map((item) => item.kind)).toEqual([
      'reconciliation-ambiguous',
    ]);
    expect(provenanceForMetric(row({ partial: true, ambiguous: true }), 'title')).toEqual([]);
  });

  test('cost provenance is metric-specific', () => {
    const provenance = provenanceForUsageRow(row({ costKnown: false, costActual: null, costQuota: null }));

    expect(provenanceForMetric(row({ costApprox: 0, costKnown: true }), 'api-value')).toEqual([]);
    expect(provenanceForMetric(row({ costApprox: 0, costKnown: false }), 'api-value').map((item) => item.kind)).toEqual(
      ['unknown-api-price'],
    );
    expect(provenanceForMetric(row({ costApprox: 1, costKnown: false }), 'api-value').map((item) => item.kind)).toEqual(
      ['partial-api-price'],
    );
    expect(provenance.map((item) => item.kind)).toContain('unknown-actual-cost');
    expect(provenance.map((item) => item.kind)).toContain('unknown-subscription-value');
    expect(provenanceForMetric(row(), 'subscription-value')).toEqual([]);
  });
});
