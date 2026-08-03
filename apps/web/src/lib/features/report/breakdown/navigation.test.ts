import { describe, expect, test } from 'bun:test';
import { type DashboardSearch, dashboardSearchDefaultsFor } from '../../../../dashboard-search';
import type { SearchNavigationOptions } from '../../../foundation/navigation/search-intent';
import { clearDashboardFilters, createBreakdownNavigation } from './navigation';

describe('P8 breakdown navigation', () => {
  test('clears report filters while preserving presentation state and column diffs', () => {
    const search: DashboardSearch = {
      ...dashboardSearchDefaultsFor('cost'),
      cols: ['model'],
      colsBase: 'work',
      filters: { campaign: 'campaign-key', provider: 'openai' },
      harness: ['codex'],
      machine: ['machine-id'],
      origin: ['human'],
      q: 'needle',
      range: { mode: '7d' },
      tab: 'projects',
      timeCell: '1:12',
    };

    const cleared = clearDashboardFilters(search);
    const { timeCell: _timeCell, ...presentation } = search;
    expect(cleared).toMatchObject({
      ...presentation,
      filters: {},
      harness: [],
      machine: [],
      origin: [],
      q: '',
      range: { mode: '30d' },
    });
    expect(cleared.timeCell).toBeUndefined();
  });

  test('uses replace for an edit run and preserves stable raw machine/filter identities', () => {
    let current = dashboardSearchDefaultsFor('cost');
    const options: (SearchNavigationOptions | undefined)[] = [];
    const navigation = createBreakdownNavigation((update, nextOptions) => {
      current = update(current);
      options.push(nextOptions);
    });

    navigation.setQuery('a', false);
    navigation.setQuery('ab', true);
    navigation.setMachine(['raw-machine-id']);
    navigation.setFieldFilter('provider', 'openai');

    expect(options.slice(0, 2)).toEqual([{ replace: false }, { replace: true }]);
    expect(current.machine).toEqual(['raw-machine-id']);
    expect(current.filters.provider).toBe('openai');
    navigation.setFieldFilter('provider', 'openai');
    expect(current.filters.provider).toBeUndefined();
  });

  test('keeps the active breakdown subtab when selecting the primary Breakdown destination', () => {
    let current: DashboardSearch = { ...dashboardSearchDefaultsFor('cost'), tab: 'projects' };
    const navigation = createBreakdownNavigation((update) => {
      current = update(current);
    });
    navigation.setPrimaryTab('breakdown');
    expect(current.tab).toBe('projects');
  });
});
