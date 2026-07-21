import { describe, expect, test } from 'bun:test';
import { loadReportPayload } from './report-runtime';

describe('report runtime loading', () => {
  test('loads the committed synthetic report without a served request in demo mode', async () => {
    const result = await loadReportPayload('demo');

    expect(result.kind).toBe('payload');
    if (result.kind === 'payload') {
      expect(result.mode).toBe('demo');
      expect(result.payload.generatedAt).toBe('2026-06-11T12:00:00.000Z');
      expect(result.payload.rows).toHaveLength(4);
    }
  });

  test('keeps E2E synthetic loading distinct from the public demo label', async () => {
    Reflect.deleteProperty(globalThis, '__aiUsageE2EReportOwnerLoads');
    const result = await loadReportPayload('e2e');

    expect(result.kind).toBe('payload');
    expect(result.mode).toBe('e2e');
    expect(Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads')).toBe(1);
  });
});
