import { describe, expect, test } from 'bun:test';
import {
  customRangeFromIndexes,
  customRangeFromInputs,
  escapedRangeDraft,
  reportRangePointerFinishType,
  reportRangeProjection,
} from './report-range-model';

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

describe('report range DOM adapter cleanup', () => {
  test('maps every pointer termination to the shared state transition', () => {
    expect(reportRangePointerFinishType('pointerup')).toBe('pointerEnd');
    expect(reportRangePointerFinishType('pointercancel')).toBe('pointerCancel');
    expect(reportRangePointerFinishType('lostpointercapture')).toBe('pointerCaptureLost');
  });

  test('restores the accepted display draft on Escape', () => {
    const projection = reportRangeProjection({ mode: '30d' }, generatedAt, domain);
    expect(escapedRangeDraft(projection, 'start')).toBe('May 12, 2026');
    expect(escapedRangeDraft(projection, 'end')).toBe('Jun 11, 2026');
  });
});

test('wires pointer cancellation, lost capture, release, and Escape into the Svelte adapter', async () => {
  const source = await Bun.file(new URL('./report-range-control.svelte', import.meta.url)).text();
  expect(source.match(/onpointercancel=\{finishPointer\}/g)).toHaveLength(2);
  expect(source.match(/onlostpointercapture=\{finishPointer\}/g)).toHaveLength(2);
  expect(source).toContain('target.releasePointerCapture(event.pointerId)');
  expect(source).toContain("event.key === 'Escape'");
  expect(source).toContain('escapedRangeDraft(projection, field)');
});
