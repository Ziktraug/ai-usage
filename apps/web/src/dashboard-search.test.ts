import { describe, expect, test } from 'bun:test';
import {
  breakdownTabFor,
  dashboardSearchDefaultsFor,
  dashboardTimeCellLabel,
  defaultDashboardDateRangeMode,
  hasActiveDashboardFilters,
  parseDashboardTimeCell,
  primaryDashboardTabFor,
  serializeDashboardTimeCell,
  sortingStateFromSearch,
  toggleExactFieldFilter,
  validateDashboardSearch,
  withoutDashboardTimeCell,
} from './dashboard-search';

describe('dashboard search params', () => {
  test('maps legacy analysis tabs, new selection, and history snapshots without rewriting deep links', () => {
    expect(primaryDashboardTabFor('overview')).toBe('overview');
    expect(primaryDashboardTabFor('sessions')).toBe('sessions');
    expect(primaryDashboardTabFor('projects')).toBe('breakdown');
    expect(breakdownTabFor('projects')).toBe('projects');
    expect(breakdownTabFor('overview')).toBe('models');
    expect(breakdownTabFor('harnesses')).toBe('harness-providers');
    expect(breakdownTabFor('providers')).toBe('harness-providers');
    expect(breakdownTabFor('harness-providers')).toBe('harness-providers');

    const defaults = dashboardSearchDefaultsFor('date');
    const historyTabs = ['harnesses', 'harness-providers', 'providers'] as const;
    const parsedTabs = historyTabs.map((tab) => validateDashboardSearch({ tab }, defaults).tab);

    expect(parsedTabs).toEqual([...historyTabs]);
    expect(parsedTabs.map((tab) => breakdownTabFor(tab))).toEqual([
      'harness-providers',
      'harness-providers',
      'harness-providers',
    ]);
  });

  test('fills defaults when params are absent', () => {
    const defaults = dashboardSearchDefaultsFor('cost');

    expect(validateDashboardSearch({}, defaults)).toEqual(defaults);
    expect(defaultDashboardDateRangeMode).toBe('30d');
    expect(defaults.range).toEqual({ mode: defaultDashboardDateRangeMode });
    expect(sortingStateFromSearch(defaults.sort)).toEqual([{ id: 'cost', desc: true }]);
  });

  test('round trips strict breakdown sorts while keeping value as the default', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(defaults.breakdownSort).toBe('value');
    expect(validateDashboardSearch({ breakdownSort: 'value' }, defaults).breakdownSort).toBe('value');
    expect(validateDashboardSearch({ breakdownSort: 'tokens' }, defaults).breakdownSort).toBe('tokens');
    expect(validateDashboardSearch({ breakdownSort: 'sessions' }, defaults).breakdownSort).toBe('sessions');
    expect(validateDashboardSearch({ breakdownSort: 'activity' }, defaults).breakdownSort).toBe('value');
  });

  test('normalizes supported dashboard state and drops invalid values', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(
      validateDashboardSearch(
        {
          campaigns: 'off',
          breakdownSort: 'sessions',
          cols: ['tokIn', 'session', 'tokIn', 'missing'],
          filters: {
            campaign: ' fixture:codex:root ',
            ignored: 'x',
            model: ' gpt-5 ',
            project: '',
            provider: 'Codex API',
          },
          harness: [' Codex ', 'Codex', 'all'],
          machine: ' work-laptop ',
          origin: ['unknown', 'classifier', 'human', 'human', 'invalid'],
          q: ' search text ',
          range: { mode: 'custom', from: '2026-06-01', to: 'not-a-date' },
          sort: { id: 'fresh', desc: false },
          tab: 'models',
        },
        defaults,
      ),
    ).toEqual({
      breakdownSort: 'sessions',
      cols: ['tokIn'],
      colsBase: 'auto',
      filters: { campaign: 'fixture:codex:root', model: 'gpt-5', provider: 'Codex API' },
      harness: ['Codex'],
      machine: ['work-laptop'],
      origin: ['human', 'classifier'],
      q: 'search text',
      range: { mode: '30d' },
      sort: { id: 'fresh', desc: false },
      tab: 'models',
    });
  });

  test('falls back for invalid range, sort, and tab values', () => {
    const defaults = dashboardSearchDefaultsFor('tokens');

    expect(
      validateDashboardSearch(
        {
          breakdownSort: 'activity',
          range: { mode: 'wat' },
          sort: { id: 'missing', desc: false },
          tab: 'missing',
          campaigns: 'sideways',
        },
        defaults,
      ),
    ).toEqual(defaults);
  });

  test('uses a neutral default while accepting explicit and stale origin selections', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(defaults.origin).toEqual([]);
    expect(validateDashboardSearch({ origin: ['classifier', 'unknown'] }, defaults).origin).toEqual(['classifier']);
    expect(
      validateDashboardSearch({ origin: ['human', 'subagent', 'classifier', 'unknown'] }, defaults).origin,
    ).toEqual([]);
    expect(validateDashboardSearch({ origin: [] }, defaults).origin).toEqual([]);
    expect(validateDashboardSearch({ origin: ['invalid'] }, defaults).origin).toEqual(defaults.origin);
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

  test('preserves explicit all-time and custom report ranges from URLs', () => {
    const defaults = dashboardSearchDefaultsFor('date');

    expect(validateDashboardSearch({ range: { mode: 'all' } }, defaults).range).toEqual({ mode: 'all' });
    expect(
      validateDashboardSearch({ range: { mode: 'custom', from: '2026-06-01', to: '2026-06-03' } }, defaults).range,
    ).toEqual({ mode: 'custom', from: '2026-06-01', to: '2026-06-03' });
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

  test('round trips strict Punchcard cells with a removable human label', () => {
    const defaults = dashboardSearchDefaultsFor('cost');
    const validated = validateDashboardSearch({ timeCell: 'MON-14' }, defaults);

    expect(validated.timeCell).toBe('MON-14');
    const parsed = parseDashboardTimeCell(validated.timeCell);
    expect(parsed).toEqual({ hour: 14, weekday: 0 });
    if (parsed === undefined) {
      throw new Error('Expected a parsed Punchcard cell');
    }
    expect(serializeDashboardTimeCell(parsed)).toBe('MON-14');
    expect(dashboardTimeCellLabel(parsed)).toBe('Monday 14:00–14:59');
    for (const invalid of ['mon-14', 'MON-4', 'MON-24', 'SUN-14-extra', '', ['MON-14']]) {
      expect(validateDashboardSearch({ timeCell: invalid }, defaults).timeCell).toBeUndefined();
    }
    expect(withoutDashboardTimeCell(validated)).toEqual(defaults);
  });

  test('detects only state that clear filters will reset', () => {
    const defaults = dashboardSearchDefaultsFor('cost');

    expect(hasActiveDashboardFilters(defaults)).toBe(false);
    expect(hasActiveDashboardFilters({ ...defaults, origin: [] })).toBe(false);
    expect(hasActiveDashboardFilters({ ...defaults, origin: ['human', 'subagent'] })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, origin: ['classifier'] })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, q: 'collector' })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, range: { mode: 'all' } })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, timeCell: 'SUN-23' })).toBe(true);
    expect(hasActiveDashboardFilters({ ...defaults, tab: 'sessions' })).toBe(false);
  });
});
