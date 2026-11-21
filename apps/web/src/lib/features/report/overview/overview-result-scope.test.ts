import { describe, expect, test } from 'bun:test';
import { projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryFilters, SessionQueryRange } from '@ai-usage/report-core/session-query';
import { demoReportPayload } from '../../../../report-data';
import type { DashboardDateRangeSearch } from '../../../foundation/dashboard/dashboard-search';
import { rangeBounds } from '../range/report-range-model';
import { buildExecutiveOverviewModel } from './executive-overview-model';
import { executivePeriodFor, type OverviewResultScope, overviewResultScope } from './overview-result-scope';

const { rows, tableRows: _tableRows, ...support } = demoReportPayload;
/** The demonstration report is generated on 11 June 2026 at noon UTC; its history starts on 12 April. */
const generatedAt = support.generatedAt;
const noFilter: SessionQueryFilters = { fields: {}, harness: [], machine: [], origin: [], query: '' };
const revisionDateDomain = { first: '2026-04-12T10:05:00.000Z', last: '2026-06-11T09:42:00.000Z' };

/** The instants a selection resolves to, exactly as the report queries are built. */
const queriedRange = (selection: DashboardDateRangeSearch): SessionQueryRange => {
  const { from, to } = rangeBounds(selection, new Date(generatedAt));
  return { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };
};
const requestedFor = (selection: DashboardDateRangeSearch) => ({ range: queriedRange(selection), selection });
const overviewFor = (range: SessionQueryRange, filters: SessionQueryFilters = noFilter) =>
  projectFocusedOverview(rows, support, {
    includeAdvanced: false,
    query: { filters, range, revision: 'scope-fixture' },
    timeline: { dimension: 'harness', granularity: 'day' },
  });

const today: DashboardDateRangeSearch = { mode: 'today' };
const thirtyDays: DashboardDateRangeSearch = { mode: '30d' };

describe('Overview result scope', () => {
  test('names the period by the selection that the result answers', () => {
    const customToday = { from: '2026-06-11', mode: 'custom', to: '2026-06-11' } as const;
    const scope = overviewResultScope({
      answered: { filters: noFilter, range: queriedRange(customToday) },
      queryGeneratedAt: generatedAt,
      requested: requestedFor(customToday),
      revisionDateDomain,
    });

    expect(scope).toEqual({
      query: { filters: noFilter, range: queriedRange(customToday) },
      rangeMode: 'custom',
      unfilteredFirst: revisionDateDomain.first,
    });
  });

  test('describes the result on screen while another period loads or after its refresh failed', () => {
    const scope = overviewResultScope({
      answered: { filters: noFilter, range: queriedRange(thirtyDays) },
      queryGeneratedAt: generatedAt,
      requested: requestedFor(today),
      revisionDateDomain,
    });

    expect(scope.query.range).toEqual(queriedRange(thirtyDays));
    expect(scope.rangeMode).toBe('30d');
  });

  test('names an earlier result by the preset it resolves to, or as a custom period', () => {
    const earlierScope = (answered: DashboardDateRangeSearch) =>
      overviewResultScope({
        answered: { filters: noFilter, range: queriedRange(answered) },
        queryGeneratedAt: generatedAt,
        requested: requestedFor(today),
        revisionDateDomain,
      }).rangeMode;

    expect(earlierScope({ mode: 'all' })).toBe('all');
    expect(earlierScope({ mode: '7d' })).toBe('7d');
    expect(earlierScope({ mode: '90d' })).toBe('90d');
    expect(earlierScope({ from: '2026-05-25', mode: 'custom', to: '2026-06-11' })).toBe('custom');
  });

  test('carries no start of history when the revision holds no dated session', () => {
    expect(
      overviewResultScope({
        answered: { filters: noFilter, range: queriedRange(today) },
        queryGeneratedAt: generatedAt,
        requested: requestedFor(today),
        revisionDateDomain: null,
      }).unfilteredFirst,
    ).toBeNull();
  });
});

describe('executive period of the result on screen', () => {
  const scopeAnswering = (
    answered: DashboardDateRangeSearch,
    requested: DashboardDateRangeSearch,
    filters: SessionQueryFilters = noFilter,
  ): OverviewResultScope =>
    overviewResultScope({
      answered: { filters, range: queriedRange(answered) },
      queryGeneratedAt: generatedAt,
      requested: requestedFor(requested),
      revisionDateDomain,
    });

  test('judges a 30-day result against its own previous window while Today is requested', () => {
    const result = overviewFor(queriedRange(thirtyDays));
    const period = executivePeriodFor(scopeAnswering(thirtyDays, today), result);
    const model = buildExecutiveOverviewModel({
      ...period,
      executive: result.view.executive,
      previousSummary: result.view.previousSummary,
      summary: result.summary,
      topItems: result.view.topSessions,
      totalSessionCount: result.summary.sessionCount,
    });

    expect(period).toEqual({
      comparisonPeriod: {
        bounds: rangeBounds(thirtyDays, new Date(generatedAt)),
        generatedAt: new Date(generatedAt),
        recordedHistory: { first: new Date(revisionDateDomain.first), limitedToHarnesses: [] },
      },
      periodInProgress: false,
      rangeMode: '30d',
    });
    // Today would compare one in-progress day with the day before and show a percentage.
    expect(model.primary.comparison.figure).toBeNull();
    expect(model.primary.comparison.outcome).toMatchObject({
      kind: 'history-shorter-than-window',
      previousPeriod: 'partly-recorded',
    });
    expect(model.primary.periodScope).toBe('in the last 30 days');
  });

  test('marks a result whose period extends past its generation instant as in progress', () => {
    const result = overviewFor(queriedRange(today));

    expect(executivePeriodFor(scopeAnswering(today, thirtyDays), result)).toMatchObject({
      periodInProgress: true,
      rangeMode: 'today',
    });
  });

  test('ends an open period at the generation instant of the revision that answered it', () => {
    const result = overviewFor(queriedRange(thirtyDays));
    const republished = { ...result, metadata: { ...result.metadata, generatedAt: '2026-06-12T08:00:00.000Z' } };

    expect(executivePeriodFor(scopeAnswering(thirtyDays, thirtyDays), republished).comparisonPeriod).toMatchObject({
      bounds: rangeBounds(thirtyDays, new Date(generatedAt)),
      generatedAt: new Date('2026-06-12T08:00:00.000Z'),
    });
  });

  test('judges coverage from the history of every harness under a non-harness filter', () => {
    const filters = { ...noFilter, query: 'OpenCode' };
    const result = overviewFor(queriedRange(thirtyDays), filters);

    expect(result.dateDomain?.first).toBe('2026-05-24T14:18:00.000Z');
    expect(executivePeriodFor(scopeAnswering(thirtyDays, thirtyDays, filters), result).comparisonPeriod).toMatchObject({
      recordedHistory: { first: new Date(revisionDateDomain.first), limitedToHarnesses: [] },
    });
  });

  test('judges coverage from the history of the selected harness under a harness filter alone', () => {
    const filters = { ...noFilter, harness: ['OpenCode'] };
    const result = overviewFor(queriedRange(thirtyDays), filters);

    expect(executivePeriodFor(scopeAnswering(thirtyDays, thirtyDays, filters), result).comparisonPeriod).toMatchObject({
      recordedHistory: { first: new Date('2026-05-24T14:18:00.000Z'), limitedToHarnesses: ['OpenCode'] },
    });
  });
});
