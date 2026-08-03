import { describe, expect, test } from 'bun:test';
import { dashboardSearchDefaultsFor } from '../../../../dashboard-search';
import { reportDestinationForSearch } from './report-search';

describe('report destination URL projection', () => {
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
});
