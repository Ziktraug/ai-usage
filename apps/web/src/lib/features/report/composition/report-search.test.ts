import { describe, expect, test } from 'bun:test';
import { dashboardSearchDefaultsFor } from '../../../../dashboard-search';
import { INITIAL_REPORT_TIMELINE } from './report-destination';
import { initialReportTimelineFor, reportDestinationForSearch } from './report-search';

describe('report destination URL projection', () => {
  test('keeps preset hydration on the seeded timeline and resolves long custom periods automatically', () => {
    const generatedAt = '2026-06-11T12:00:00.000Z';
    for (const mode of ['30d', '7d', '90d', 'today', 'all'] as const) {
      expect(initialReportTimelineFor({ mode }, generatedAt)).toEqual(INITIAL_REPORT_TIMELINE);
    }
    expect(initialReportTimelineFor({ from: '2026-01-01', mode: 'custom', to: '2026-06-11' }, generatedAt)).toEqual({
      dimension: 'harness',
      granularity: 'week',
    });
  });

  test('projects one canonical search snapshot into exact focused and Sessions scopes', () => {
    const search = {
      ...dashboardSearchDefaultsFor('date'),
      filters: { project: 'ai-usage' },
      harness: ['codex'],
      q: 'migration',
      range: { from: '2026-08-01', mode: 'custom' as const, to: '2026-08-02' },
      tab: 'models' as const,
      timeCell: 'MON-09',
    };

    const destination = reportDestinationForSearch(search, '2026-08-02T12:00:00.000Z', {
      dimension: 'project',
      granularity: 'week',
    });

    expect(destination.focused).toEqual({
      kind: 'breakdown',
      query: {
        filters: {
          fields: { project: 'ai-usage' },
          harness: ['codex'],
          localTimeCell: { hour: 9, weekday: 0 },
          machine: [],
          origin: [],
          query: 'migration',
        },
        range: {
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-02T23:59:59.999Z',
        },
      },
      timeline: { dimension: 'project', granularity: 'week' },
    });
    if (!destination.focused) {
      throw new Error('Expected a focused Breakdown destination');
    }
    expect(destination.sessions.filters).toEqual(destination.focused.query.filters);
    expect(destination.sessions.range).toEqual(destination.focused.query.range);
    expect(Object.hasOwn(destination.sessions, 'cursor')).toBe(false);
    expect(Object.hasOwn(destination.sessions, 'revision')).toBe(false);
  });

  test('keeps the timeline-only Overview acquisition while Sessions owns the visible destination', () => {
    const search = { ...dashboardSearchDefaultsFor('date'), tab: 'sessions' as const };
    const timeline = { dimension: 'harness' as const, granularity: 'day' as const };

    const destination = reportDestinationForSearch(search, '2026-08-02T12:00:00.000Z', timeline);

    expect(destination.focused).toEqual({
      kind: 'sessions',
      query: {
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        range: { from: '2026-07-03T00:00:00.000Z', to: null },
      },
      sessions: destination.sessions,
      timeline,
    });
  });
});
