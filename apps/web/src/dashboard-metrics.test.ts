import { describe, expect, test } from 'bun:test';
import {
  fmtDeltaPct,
  metricComparisonMessage,
  metricComparisonStateFor,
  metricDeltaFaceLabel,
  splitDashboardMetrics,
} from './dashboard-metrics';

describe('dashboard metric delta presentation', () => {
  test('keeps the compact value and its comparison basis together', () => {
    expect(metricDeltaFaceLabel(115)).toBe('115% vs previous period');
    expect(metricDeltaFaceLabel(4632)).toBe('×47 vs previous period');
  });

  test('retains the existing compact percentage formatter', () => {
    expect(fmtDeltaPct(-12.34)).toBe('12%');
  });
});

describe('dashboard metric sections', () => {
  test('groups value bases in semantic order without changing their definitions', () => {
    const sessions = { label: 'Sessions', value: '3' };
    const subscription = { hint: 'Covered by quota', label: 'Sub value', value: '$9.00' };
    const api = { hint: 'Standard API prices', label: 'API value · measured', value: '$12.00' };
    const actual = { hint: 'Out-of-pocket spend', label: 'Actual cost', value: '$3.00' };

    expect(splitDashboardMetrics([sessions, subscription, api, actual])).toEqual({
      remainingMetrics: [sessions],
      valueBases: [api, actual, subscription],
    });
  });
});

describe('dashboard metric comparison state', () => {
  test('distinguishes available, full-range, and bounded no-data states', () => {
    const available = metricComparisonStateFor('30d', {});
    const fullRange = metricComparisonStateFor('all', null);
    const noPriorData = metricComparisonStateFor('30d', null);

    expect(available).toBe('available');
    expect(metricComparisonMessage(available)).toBeNull();
    expect(fullRange).toBe('full-range');
    expect(metricComparisonMessage(fullRange)).toBe('No previous period exists before the full recorded range.');
    expect(noPriorData).toBe('no-prior-data');
    expect(metricComparisonMessage(noPriorData)).toBe('No sessions exist in the previous period.');
  });
});
