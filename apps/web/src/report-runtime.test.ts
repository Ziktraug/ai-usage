import { describe, expect, test } from 'bun:test';
import { loadReportRouteData } from './report-runtime';

describe('report runtime loading', () => {
  test('loads the committed synthetic report without a served request in demo mode', async () => {
    const result = await loadReportRouteData('demo');

    expect(result.kind).toBe('payload');
    if (result.kind === 'payload') {
      expect(result.mode).toBe('demo');
      expect(result.payload.generatedAt).toBe('2026-06-11T12:00:00.000Z');
      expect(result.payload.rows).toHaveLength(4);
    }
  });

  test('keeps E2E synthetic loading distinct from the isolated runtime label', async () => {
    Reflect.deleteProperty(globalThis, '__aiUsageE2EReportOwnerLoads');
    Reflect.deleteProperty(globalThis, '__aiUsageE2EReportLoadFailures');
    const result = await loadReportRouteData('e2e');

    expect(result.kind).toBe('payload');
    expect(result.mode).toBe('e2e');
    expect(Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads')).toBe(1);
  });

  test('supports a deterministic E2E-only load failure without touching demo data', async () => {
    Reflect.set(globalThis, '__aiUsageE2EReportLoadFailures', 1);

    await expect(loadReportRouteData('e2e')).rejects.toThrow('Synthetic report load failed for retry coverage.');
    const retried = await loadReportRouteData('e2e');

    expect(retried.kind).toBe('payload');
    Reflect.deleteProperty(globalThis, '__aiUsageE2EReportLoadFailures');
  });
});
