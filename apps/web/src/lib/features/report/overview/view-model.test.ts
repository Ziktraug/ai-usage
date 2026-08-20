import { describe, expect, test } from 'bun:test';
import type { FocusedReportSummary } from '@ai-usage/report-core/focused-report-query';
import { apiPriceMeasurement } from '@ai-usage/report-core/provenance';
import { originGapDescription, tokenAnatomyRows } from './view-model';

const summary = (overrides: Partial<FocusedReportSummary> = {}): FocusedReportSummary => ({
  actualCost: 3,
  cacheRead: 60,
  cacheWrite: 20,
  costQuota: 9,
  fresh: 30,
  meanCost: 4,
  pricedSessions: 2,
  priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 30, knownCost: 12 }),
  rtkInput: 0,
  rtkOutput: 0,
  rtkSaved: 5,
  rtkSessions: 1,
  sessionCount: 3,
  tokIn: 20,
  tokOut: 10,
  tools: 7,
  totalCost: 12,
  turns: 8,
  unknownActual: 1,
  ...overrides,
});

describe('Overview presentation adapters', () => {
  test('keeps token anatomy as four exact rows with percentages', () => {
    expect(tokenAnatomyRows(summary())).toEqual([
      { key: 'cache-read', label: 'Cache read', percentage: '55%', value: '60' },
      { key: 'cache-write', label: 'Cache write', percentage: '18%', value: '20' },
      { key: 'input', label: 'Input', percentage: '18%', value: '20' },
      { key: 'output', label: 'Output', percentage: '9.1%', value: '10' },
    ]);
  });

  test('spells out every undeclared-origin cause', () => {
    const description = originGapDescription({
      causes: [
        { kind: 'origin-unsupported', sessions: 1 },
        { kind: 'origin-absent', sessions: 2 },
        { kind: 'origin-degraded', sessions: 3 },
      ],
      priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 }),
      sessions: 6,
      tokens: 0,
      total: 0,
    });
    expect(description).toContain('Origin unsupported: 1 session');
    expect(description).toContain('Origin not declared: 2 sessions');
    expect(description).toContain('Origin unavailable: 3 sessions');
  });
});

test('keeps the decision-first Overview and provider-last reading order', async () => {
  const pageSource = await Bun.file(new URL('./overview-page.svelte', import.meta.url)).text();
  const orderedSurfaces = [
    '<ExecutiveOverview',
    '<Records',
    '<ActivityHeatmap',
    '<TokenAnatomy',
    'aria-labelledby="advanced-analysis-title"',
    '<ProviderStatus',
  ];
  const positions = orderedSurfaces.map((surface) => pageSource.indexOf(surface));

  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  expect(pageSource).not.toContain('<DashboardMetrics');

  const executiveSource = await Bun.file(new URL('./executive-overview.svelte', import.meta.url)).text();
  const executiveSurfaces = [
    'data-executive-kpi',
    '<ActivityExplorer',
    'data-executive-metrics',
    'data-period-insight',
    'Top models',
  ];
  const executivePositions = executiveSurfaces.map((surface) => executiveSource.indexOf(surface));
  expect(executivePositions.every((position) => position >= 0)).toBe(true);
  expect(executivePositions).toEqual([...executivePositions].sort((left, right) => left - right));
  for (const forbiddenClaim of ['actual spend', 'bill', 'invoice', 'saving', 'ROI']) {
    expect(executiveSource.toLowerCase()).not.toContain(forbiddenClaim.toLowerCase());
  }
});
