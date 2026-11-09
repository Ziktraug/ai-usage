import { expect, test } from 'bun:test';
import type { FocusedReportDestination } from './report-destination';
import { reportRegionStaleness, reportVisibleRequestPending } from './report-region-staleness';

const sessions = (): Extract<FocusedReportDestination, { kind: 'sessions' }> => ({
  kind: 'sessions',
  timeline: { dimension: 'harness', granularity: 'day' },
  query: { filters: { fields: {}, harness: [], machine: [], origin: [], query: '' }, range: { from: null, to: null } },
  sessions: {
    filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
    range: { from: null, to: null },
    pageSize: 200,
    sort: [{ desc: true, id: 'date' }],
  },
});

test('range and filter changes qualify both request-dependent regions', () => {
  const settled = sessions();
  const range = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-08T00:00:00.000Z' };
  expect(
    reportRegionStaleness(settled, {
      ...settled,
      query: { ...settled.query, range },
      sessions: { ...settled.sessions, range },
    }),
  ).toEqual({ overview: true, panel: true });
  const filters = { ...settled.query.filters, query: 'changed' };
  expect(
    reportRegionStaleness(settled, {
      ...settled,
      query: { ...settled.query, filters },
      sessions: { ...settled.sessions, filters },
    }),
  ).toEqual({ overview: true, panel: true });
});

test('a sessions sort changes only the table request; a timeline change only the overview request', () => {
  const settled = sessions();
  expect(
    reportRegionStaleness(settled, {
      ...settled,
      sessions: { ...settled.sessions, sort: [{ id: 'cost', desc: true }] },
    }),
  ).toEqual({ overview: false, panel: true });
  expect(reportRegionStaleness(settled, { ...settled, timeline: { dimension: 'model', granularity: 'week' } })).toEqual(
    { overview: true, panel: false },
  );
});

test('tab changes retain crisp regions whose requests remain identical', () => {
  const settled = sessions();
  const breakdown: FocusedReportDestination = { kind: 'breakdown', query: settled.query, timeline: settled.timeline };
  expect(reportRegionStaleness(settled, breakdown)).toEqual({ overview: false, panel: true });
  expect(
    reportRegionStaleness(settled, {
      kind: 'overview',
      includeAdvanced: true,
      query: settled.query,
      timeline: settled.timeline,
    }),
  ).toEqual({ overview: true, panel: true });
  expect(reportRegionStaleness(settled, settled)).toEqual({ overview: false, panel: false });
  const stale = reportRegionStaleness(settled, breakdown);
  expect(stale).toEqual({ overview: false, panel: true });
  expect(reportVisibleRequestPending(true, false, true, stale)).toBe(false);
  expect(reportVisibleRequestPending(true, true, false, stale)).toBe(true);
  expect(reportVisibleRequestPending(true, true, false, { overview: false, panel: false })).toBe(false);
});
