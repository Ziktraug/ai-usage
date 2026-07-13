import { describe, expect, test } from 'bun:test';
import { payloadStats } from './client-perf';
import type { WebReportPayload } from './web-report-payload';

describe('client performance payload statistics', () => {
  test('counts UTF-8 transport bytes rather than UTF-16 code units', () => {
    const payload = { rows: [], warnings: [{ message: 'é漢字' }] } as unknown as WebReportPayload;

    expect(payloadStats(payload).bytes).toBe(new TextEncoder().encode(JSON.stringify(payload)).byteLength);
  });
});
