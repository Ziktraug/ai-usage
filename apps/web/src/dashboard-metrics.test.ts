import { describe, expect, test } from 'bun:test';
import { fmtDeltaPct, metricDeltaFaceLabel } from './dashboard-metrics';

describe('dashboard metric delta presentation', () => {
  test('keeps the compact value and its comparison basis together', () => {
    expect(metricDeltaFaceLabel(115)).toBe('115% vs previous period');
    expect(metricDeltaFaceLabel(4632)).toBe('×47 vs previous period');
  });

  test('retains the existing compact percentage formatter', () => {
    expect(fmtDeltaPct(-12.34)).toBe('12%');
  });
});
