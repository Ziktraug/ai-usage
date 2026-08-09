import { describe, expect, test } from 'bun:test';
import {
  customRangeFromIndexes,
  customRangeFromInputs,
  escapedRangeDraft,
  rangeBounds,
  reportRangeEditKey,
  reportRangePointerFinishType,
  reportRangeProjection,
  validateCustomRangeInputs,
} from './report-range-model';

const generatedAt = new Date('2026-06-11T12:00:00.000Z');
const domain = { first: '2026-05-01', last: '2026-06-11' } as const;

describe('report range projection', () => {
  test('uses one edit key regardless of producer property order', () => {
    expect(reportRangeEditKey({ mode: 'custom', from: '2026-05-20', to: '2026-06-08' })).toBe(
      reportRangeEditKey({ from: '2026-05-20', mode: 'custom', to: '2026-06-08' }),
    );
  });

  test('projects the shared 30-day report range onto the chart domain', () => {
    const projection = reportRangeProjection({ mode: '30d' }, generatedAt, domain);

    expect(projection.displayFrom).toBe('May 12, 2026');
    expect(projection.displayTo).toBe('Jun 11, 2026');
    expect(projection.summary).toBe('May 12 → Jun 11, 2026 · 30 days');
    expect(projection.selectionIndexes).toEqual([11, 41]);
  });

  test('projects the 90-day preset without changing the 30-day default', () => {
    const projection = reportRangeProjection({ mode: '90d' }, generatedAt, domain);

    expect(projection.displayFrom).toBe('Mar 13, 2026');
    expect(projection.displayTo).toBe('Jun 11, 2026');
    expect(projection.summary).toBe('Mar 13 → Jun 11, 2026 · 90 days');
    expect(projection.selectionIndexes).toEqual([0, 90]);
  });

  test('preserves the unpadded Solid start-day summary', () => {
    const projection = reportRangeProjection({ mode: '30d' }, new Date('2026-07-03T12:00:00.000Z'), {
      first: '2026-06-01',
      last: '2026-07-03',
    });

    expect(projection.summary).toBe('Jun 3 → Jul 03, 2026 · 30 days');
  });

  test('keeps a canonical preset range when filtered data has a sparse domain', () => {
    const projection = reportRangeProjection({ mode: '7d' }, generatedAt, {
      first: '2026-06-11T09:42:00.000Z',
      last: '2026-06-11T09:42:00.000Z',
    });

    expect(projection.maxIndex).toBe(7);
    expect(projection.selectionIndexes).toEqual([0, 7]);
    expect(projection.displayFrom).toBe('Jun 04, 2026');
    expect(projection.displayTo).toBe('Jun 11, 2026');
  });

  test('normalizes report query bounds to the calendar days shown by the control', () => {
    const bounds = rangeBounds({ mode: '30d' }, generatedAt);

    expect(bounds.from?.getHours()).toBe(0);
    expect(bounds.from?.getMinutes()).toBe(0);
    expect(bounds.from?.getDate()).toBe(12);
  });

  test('accepts the focused report ISO date domain for the all-time range', () => {
    const projection = reportRangeProjection({ mode: 'all' }, generatedAt, {
      first: '2026-04-12T10:05:00.000Z',
      last: '2026-06-11T09:42:00.000Z',
    });

    expect(projection.displayFrom).toBe('Apr 12, 2026');
    expect(projection.displayTo).toBe('Jun 11, 2026');
  });

  test('falls back safely for invalid canonical and timestamp domain dates', () => {
    const projection = reportRangeProjection({ mode: 'all' }, generatedAt, {
      first: '2026-02-31',
      last: 'not-a-date',
    });

    expect(projection.displayFrom).toBe('May 12, 2026');
    expect(projection.displayTo).toBe('Jun 11, 2026');
  });

  test('rejects invalid or reversed text ranges without mutating state', () => {
    expect(customRangeFromInputs('2026-06-12', '2026-06-11')).toBeNull();
    expect(customRangeFromInputs('not-a-date', '2026-06-11')).toBeNull();
    expect(validateCustomRangeInputs('not-a-date', '2026-06-11')).toEqual({
      invalidField: 'from',
      message: 'Enter a valid From date.',
      status: 'invalid',
    });
    expect(validateCustomRangeInputs('2026-06-12', '2026-06-11')).toEqual({
      invalidField: 'range',
      message: 'From date must be on or before To date.',
      status: 'invalid',
    });
    expect(validateCustomRangeInputs('2026-06-10', '2026-06-11')).toEqual({
      range: { from: '2026-06-10', mode: 'custom', to: '2026-06-11' },
      status: 'valid',
    });
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

test('wires pointer cancellation and lost capture into the activity explorer', async () => {
  const source = await Bun.file(new URL('./activity-explorer.svelte', import.meta.url)).text();
  expect(source.match(/onpointercancel=\{finishPointer\}/g)).toHaveLength(2);
  expect(source.match(/onlostpointercapture=\{finishPointer\}/g)).toHaveLength(2);
  expect(source).toContain('target.releasePointerCapture(event.pointerId)');
});

test('keeps invalid custom drafts announced and restores the committed range on Escape', async () => {
  const source = await Bun.file(new URL('./report-period-control.svelte', import.meta.url)).text();
  expect(source).toContain('aria-invalid={invalidFrom}');
  expect(source).toContain('aria-invalid={invalidTo}');
  expect(source).toContain('aria-describedby={validationError ? customErrorId : undefined}');
  expect(source).toContain('validateCustomRangeInputs(draftFrom, draftTo)');
  expect(source).toContain("event.key !== 'Escape'");
  expect(source).toContain('restoreCommittedDraft()');
});
