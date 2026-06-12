import { describe, expect, test } from 'bun:test';
import {
  dashboardSearchDefaultsFor,
  sortingStateFromSearch,
  validateDashboardSearch,
} from './dashboard-search';

describe('dashboard search params', () => {
  test('fills defaults when params are absent', () => {
    const defaults = dashboardSearchDefaultsFor('cost');

    expect(validateDashboardSearch({}, defaults)).toEqual(defaults);
    expect(sortingStateFromSearch(defaults.sort)).toEqual([{ id: 'cost', desc: true }]);
  });

  test('normalizes supported dashboard state and drops invalid values', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(
      validateDashboardSearch(
        {
          cols: ['tokIn', 'session', 'tokIn', 'missing'],
          filters: {
            ignored: 'x',
            model: ' gpt-5 ',
            project: '',
            provider: 'Codex API',
          },
          harness: ' Codex ',
          q: ' search text ',
          range: { mode: 'custom', from: '2026-06-01', to: 'not-a-date' },
          sort: { id: 'fresh', desc: false },
          tab: 'models',
        },
        defaults,
      ),
    ).toEqual({
      cols: ['tokIn'],
      filters: { model: 'gpt-5', provider: 'Codex API' },
      harness: 'Codex',
      q: 'search text',
      range: { mode: 'custom', from: '2026-06-01' },
      sort: { id: 'fresh', desc: false },
      tab: 'models',
    });
  });

  test('falls back for invalid range, sort, and tab values', () => {
    const defaults = dashboardSearchDefaultsFor('tokens');

    expect(
      validateDashboardSearch(
        {
          range: { mode: 'wat' },
          sort: { id: 'missing', desc: false },
          tab: 'missing',
        },
        defaults,
      ),
    ).toEqual(defaults);
  });
});
