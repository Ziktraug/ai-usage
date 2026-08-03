import { describe, expect, test } from 'bun:test';
import { customRangeFromIndexes, customRangeFromInputs, reportRangeProjection } from './report-range-model';

const generatedAt = new Date('2026-06-11T12:00:00.000Z');
const domain = { first: '2026-05-01', last: '2026-06-11' } as const;

describe('report range projection', () => {
  test('projects the shared 30-day report range onto the chart domain', () => {
    const projection = reportRangeProjection({ mode: '30d' }, generatedAt, domain);

    expect(projection.displayFrom).toBe('May 12, 2026');
    expect(projection.displayTo).toBe('Jun 11, 2026');
    expect(projection.summary).toBe('May 12 → Jun 11, 2026 · 30 days');
    expect(projection.selectionIndexes).toEqual([11, 41]);
  });

  test('rejects invalid or reversed text ranges without mutating state', () => {
    expect(customRangeFromInputs('2026-06-12', '2026-06-11')).toBeNull();
    expect(customRangeFromInputs('not-a-date', '2026-06-11')).toBeNull();
  });

  test('turns chart selection indexes into one canonical report range', () => {
    const projection = reportRangeProjection({ mode: 'all' }, generatedAt, domain);
    expect(customRangeFromIndexes(projection, [4, 9])).toEqual({
      from: '2026-05-05',
      mode: 'custom',
      to: '2026-05-10',
    });
  });
});
