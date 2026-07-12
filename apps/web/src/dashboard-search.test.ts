import { describe, expect, test } from 'bun:test';
import {
  dashboardSearchDefaultsFor,
  hasActiveDashboardFilters,
  sortingStateFromSearch,
  toggleExactFieldFilter,
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
          campaigns: 'off',
          cols: ['tokIn', 'session', 'tokIn', 'missing'],
          filters: {
            ignored: 'x',
            model: ' gpt-5 ',
            project: '',
            provider: 'Codex API',
          },
          harness: [' Codex ', 'Codex', 'all'],
          machine: ' work-laptop ',
          q: ' search text ',
          range: { mode: 'custom', from: '2026-06-01', to: 'not-a-date' },
          sort: { id: 'fresh', desc: false },
          tab: 'models',
        },
        defaults,
      ),
    ).toEqual({
      campaigns: 'off',
      cols: ['tokIn'],
      colsBase: 'auto',
      filters: { model: 'gpt-5', provider: 'Codex API' },
      harness: ['Codex'],
      machine: ['work-laptop'],
      q: 'search text',
      range: { mode: 'all' },
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
          campaigns: 'sideways',
        },
        defaults,
      ),
    ).toEqual(defaults);
  });

  test('versions column visibility while preserving unversioned legacy links', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(validateDashboardSearch({ cols: ['machine'] }, defaults).colsBase).toBe('auto');
    expect(validateDashboardSearch({ cols: [], colsBase: 'legacy' }, defaults).colsBase).toBe('legacy');
    expect(validateDashboardSearch({ cols: [], colsBase: 'invalid' }, defaults).colsBase).toBe('auto');
  });

  test('falls back when custom dates are impossible or reversed', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(
      validateDashboardSearch({ range: { mode: 'custom', from: '2026-02-31', to: '2026-03-03' } }, defaults).range,
    ).toEqual(defaults.range);
    expect(
      validateDashboardSearch({ range: { mode: 'custom', from: '2026-03-03', to: '2026-02-28' } }, defaults).range,
    ).toEqual(defaults.range);
  });

  test('toggles an exact field filter without disturbing the other dimensions', () => {
    expect(toggleExactFieldFilter({ project: 'ai-usage' }, 'model', 'gpt-5')).toEqual({
      model: 'gpt-5',
      project: 'ai-usage',
    });
    expect(toggleExactFieldFilter({ model: 'gpt-5', project: 'ai-usage' }, 'model', 'gpt-5')).toEqual({
      project: 'ai-usage',
    });
  });

  test('detects only state that clear filters will reset', () => {
    const defaults = dashboardSearchDefaultsFor('cost');

    expect(hasActiveDashboardFilters(defaults)).toBe(false);
    expect(hasActiveDashboardFilters({ ...defaults, q: 'collector' })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, range: { mode: '30d' } })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, tab: 'sessions' })).toBe(false);
  });
});
