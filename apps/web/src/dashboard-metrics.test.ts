import { describe, expect, test } from 'bun:test';
import {
  fmtDeltaPct,
  metricComparisonMessage,
  metricComparisonStateFor,
  metricDeltaFaceLabel,
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
