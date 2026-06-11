import { describe, expect, test } from 'bun:test';
import { readReportPayload } from './report-data';

describe('report payload bootstrap', () => {
  test('provides a development payload when no CLI data is injected', () => {
    expect(readReportPayload().rows.length).toBeGreaterThan(0);
  });
});
