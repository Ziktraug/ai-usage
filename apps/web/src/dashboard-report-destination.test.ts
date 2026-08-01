import { describe, expect, test } from 'bun:test';
import type { FocusedReportQueryScope } from '@ai-usage/report-core/focused-report-query';
import { buildDashboardReportDestinationScope } from './dashboard-report-destination';
import type { SessionQueryScope } from './session-query-client';

const query: FocusedReportQueryScope = {
  filters: { fields: {}, harness: [], machine: [], query: 'needle' },
  range: { from: null, to: null },
  revision: 'revision-a',
};

const sessions: SessionQueryScope = {
  filters: query.filters,
  pageSize: 100,
  range: query.range,
  sort: [{ desc: true, id: 'date' }],
};

describe('dashboard report destination scope', () => {
  test('keeps pagination outside the stable Sessions destination interface', () => {
    expect(buildDashboardReportDestinationScope('sessions', query, sessions)).toEqual({
      kind: 'sessions',
      query: {
        filters: query.filters,
        range: query.range,
      },
      sessions,
    });
  });

  test('maps visual tabs without leaking the served revision into destination reactivity', () => {
    expect(buildDashboardReportDestinationScope('overview', query, sessions)).toEqual({
      kind: 'overview',
      query: {
        filters: query.filters,
        range: query.range,
      },
    });
    expect(buildDashboardReportDestinationScope('models', query, sessions)).toEqual({
      kind: 'breakdown',
      query: {
        filters: query.filters,
        range: query.range,
      },
    });
  });
});
