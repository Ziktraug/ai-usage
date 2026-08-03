import { describe, expect, test } from 'bun:test';
import {
  createDashboardSearchNavigation,
  createSearchEditRun,
  type DashboardSearchCodec,
  dashboardUrlFor,
  parseDashboardSearchUrl,
} from './dashboard-url';
import { createMemoryNavigationPort, type NavigationIntent } from './navigation';

interface DashboardFixture {
  breakdownSort: string;
  cols: string[];
  colsBase: string;
  filters: Record<string, string>;
  harness: string[];
  machine: string[];
  origin: string[];
  q: string;
  range: { from?: string; mode: string; to?: string };
  sort: { desc: boolean; id: string };
  tab: string;
  timeCell?: string;
}

interface DashboardSearchModule {
  readonly dashboardSearchDefaultsFor: (sortId: string) => DashboardFixture;
  readonly toggleExactFieldFilter: (
    filters: Record<string, string>,
    key: 'campaign' | 'model' | 'project' | 'provider',
    value: string,
  ) => Record<string, string>;
  readonly validateDashboardSearch: (raw: Record<string, unknown>, defaults: DashboardFixture) => DashboardFixture;
}

interface DashboardFilterModule {
  readonly applyTimelineDimensionFilter: (
    search: DashboardFixture,
    dimension: 'campaign' | 'harness' | 'machine' | 'model' | 'origin' | 'project' | 'provider',
    value: string,
  ) => DashboardFixture;
}

interface SessionSchemaModule {
  readonly columnVisibilityFromDiff: (columns: string[], base?: string) => Record<string, boolean>;
  readonly sessionColumnIds: string[];
}

// Keep Solid-only type dependencies outside Svelte's static closure while still
// exercising the frozen production parser at runtime.
const dashboardSearchModuleId: string = '../../../../dashboard-search';
const dashboardSearchModule = (await import(dashboardSearchModuleId)) as DashboardSearchModule;
const dashboardFilterModuleId: string = '../../../../dashboard-filter-navigation';
const dashboardFilterModule = (await import(dashboardFilterModuleId)) as DashboardFilterModule;
const sessionSchemaModuleId: string = '../../../../session-table-schema';
const sessionSchemaModule = (await import(sessionSchemaModuleId)) as SessionSchemaModule;
const codec: DashboardSearchCodec<DashboardFixture> = {
  defaults: dashboardSearchModule.dashboardSearchDefaultsFor('date'),
  validate: dashboardSearchModule.validateDashboardSearch,
};
const { defaults } = codec;

const trackedNavigation = (initialUrl = 'http://local/?utm=kept') => {
  const memory = createMemoryNavigationPort(initialUrl);
  const intents: NavigationIntent[] = [];
  const port = {
    ...memory,
    navigate: async (intent: NavigationIntent) => {
      intents.push(intent);
      await memory.navigate(intent);
    },
  };
  return {
    intents,
    memory,
    navigate: createDashboardSearchNavigation(port, codec, () => undefined),
  };
};

describe('dashboard URL parity', () => {
  test('[url:dashboard.tab] covers canonical/default/legacy values and push/no-scroll history', () => {
    const canonical = ['overview', 'sessions', 'models', 'harness-providers', 'projects', 'cursor-ai'];
    for (const tab of canonical) {
      expect(parseDashboardSearchUrl(new URL(`http://local/?tab=${tab}`), codec).tab).toBe(tab);
    }
    for (const tab of ['providers', 'harnesses']) {
      expect(parseDashboardSearchUrl(new URL(`http://local/?tab=${tab}`), codec).tab).toBe(tab);
    }
    expect(dashboardUrlFor(new URL('http://local/?utm=x'), { ...defaults, tab: 'overview' }, codec).search).toBe(
      '?utm=x',
    );
    expect(
      dashboardUrlFor(new URL('http://local/?utm=x'), { ...defaults, tab: 'sessions' }, codec).searchParams.get('tab'),
    ).toBe('sessions');
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, tab: 'models' }));
    expect(fixture.memory.entries()).toHaveLength(2);
    expect(fixture.intents.at(-1)).toMatchObject({ resetScroll: false });
    fixture.memory.traverse(-1);
    expect(parseDashboardSearchUrl(fixture.memory.currentUrl(), codec).tab).toBe('overview');
  });

  test('[url:dashboard.breakdown-sort] canonicalizes strict values and strips value', () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?breakdownSort=bad'), codec).breakdownSort).toBe('value');
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, breakdownSort: 'value' }, codec).search).toBe('');
    expect(
      dashboardUrlFor(new URL('http://local/'), { ...defaults, breakdownSort: 'tokens' }, codec).searchParams.get(
        'breakdownSort',
      ),
    ).toBe('tokens');
    expect(parseDashboardSearchUrl(new URL('http://local/?breakdownSort=sessions'), codec).breakdownSort).toBe(
      'sessions',
    );
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, breakdownSort: 'sessions' }));
    expect(fixture.memory.entries()).toHaveLength(2);
    expect(fixture.intents.at(-1)?.replace).toBeUndefined();
  });

  test('[url:dashboard.query] pushes/replaces, preserves params, and reports rejected navigation', async () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?q=12'), codec).q).toBe('');
    expect(dashboardUrlFor(new URL('http://local/?utm=kept'), { ...defaults, q: '' }, codec).search).toBe('?utm=kept');
    const run = createSearchEditRun();
    const port = createMemoryNavigationPort('http://local/?utm=kept');
    const failures: unknown[] = [];
    const navigate = createDashboardSearchNavigation(port, codec, (failure) => failures.push(failure));
    navigate((current) => ({ ...current, q: '  report  ' }), run.next());
    expect(port.entries()).toHaveLength(2);
    expect(run.next()).toEqual({ keepFocus: true, replace: true, resetScroll: false, shallow: true });
    navigate((current) => ({ ...current, q: 'reloaded' }), run.next());
    expect(port.entries()).toHaveLength(2);
    expect(parseDashboardSearchUrl(new URL(port.currentUrl()), codec).q).toBe('reloaded');
    run.commit();
    navigate((current) => ({ ...current, q: 'report' }), run.next());
    expect(port.entries()).toHaveLength(3);
    expect(port.currentUrl().searchParams.get('q')).toBe('report');
    expect(port.currentUrl().searchParams.get('utm')).toBe('kept');
    const failure = new Error('synthetic Dashboard navigation failure');
    const rejectingPort = { ...port, navigate: () => Promise.reject(failure) };
    createDashboardSearchNavigation(rejectingPort, codec, (reported) => failures.push(reported))(
      (current) => ({ ...current, q: 'next' }),
      { replace: true },
    );
    await Promise.resolve();
    expect(failures).toEqual([{ cause: failure, url: new URL('http://local/?utm=kept&q=next') }]);
  });

  test('[url:dashboard.harness] accepts legacy scalar, deduplicates, and strips all/default', () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?harness=Codex'), codec).harness).toEqual(['Codex']);
    const url = dashboardUrlFor(new URL('http://local/'), { ...defaults, harness: ['Codex', 'Codex'] }, codec);
    expect(parseDashboardSearchUrl(url, codec).harness).toEqual(['Codex']);
    expect(parseDashboardSearchUrl(new URL('http://local/?harness=all'), codec).harness).toEqual([]);
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, harness: ['Codex'] }));
    fixture.navigate((current) => ({ ...current, harness: [] }));
    expect(fixture.memory.entries()).toHaveLength(3);
    expect(fixture.memory.currentUrl().searchParams.get('utm')).toBe('kept');
  });

  test('[url:dashboard.machine] retains raw stale identity across direct/reload and strips all/default', () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?machine=work-laptop'), codec).machine).toEqual([
      'work-laptop',
    ]);
    const url = dashboardUrlFor(new URL('http://local/'), { ...defaults, machine: ['raw stale'] }, codec);
    expect(parseDashboardSearchUrl(url, codec).machine).toEqual(['raw stale']);
    expect(parseDashboardSearchUrl(new URL(url), codec).machine).toEqual(['raw stale']);
    expect(parseDashboardSearchUrl(new URL('http://local/?machine=all'), codec).machine).toEqual([]);
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, machine: ['raw stale'] }));
    fixture.navigate((current) => ({ ...current, machine: [] }));
    expect(fixture.memory.entries()).toHaveLength(3);
  });

  test('[url:dashboard.origin] keeps canonical order and strips the neutral all selection', () => {
    expect(
      parseDashboardSearchUrl(new URL('http://local/?origin=%5B%22unknown%22%2C%22human%22%5D'), codec).origin,
    ).toEqual(['human']);
    expect(parseDashboardSearchUrl(new URL('http://local/?origin=classifier'), codec).origin).toEqual(['classifier']);
    const all = encodeURIComponent(JSON.stringify(['human', 'subagent', 'classifier', 'unknown']));
    expect(parseDashboardSearchUrl(new URL(`http://local/?origin=${all}`), codec).origin).toEqual([]);
    expect(parseDashboardSearchUrl(new URL('http://local/?origin=invalid'), codec).origin).toEqual([]);
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, origin: [] }, codec).search).toBe('');
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, origin: ['human'] }));
    fixture.navigate((current) => ({ ...current, origin: [] }));
    expect(fixture.memory.entries()).toHaveLength(3);
  });

  test('[url:dashboard.field-filters] drops unknown/empty fields and preserves unrelated parameters', () => {
    const parsed = parseDashboardSearchUrl(
      new URL('http://local/?filters=%7B%22model%22%3A%22+gpt-5+%22%2C%22ignored%22%3A%22x%22%7D&utm=x'),
      codec,
    );
    expect(parsed.filters).toEqual({ model: 'gpt-5' });
    expect(
      dashboardUrlFor(new URL('http://local/?utm=x'), { ...defaults, filters: parsed.filters }, codec).searchParams.get(
        'utm',
      ),
    ).toBe('x');
    const fixture = trackedNavigation('http://local/?utm=kept&q=existing');
    fixture.navigate((current) =>
      dashboardFilterModule.applyTimelineDimensionFilter(current, 'campaign', 'campaign:alpha'),
    );
    expect(parseDashboardSearchUrl(fixture.memory.currentUrl(), codec).filters).toEqual({ campaign: 'alpha' });
    expect(parseDashboardSearchUrl(fixture.memory.currentUrl(), codec).q).toBe('existing');
    fixture.navigate((current) =>
      dashboardFilterModule.applyTimelineDimensionFilter(current, 'campaign', 'campaign:alpha'),
    );
    expect(parseDashboardSearchUrl(fixture.memory.currentUrl(), codec).filters).toEqual({});
    expect(fixture.memory.entries()).toHaveLength(3);
    expect(fixture.memory.currentUrl().searchParams.get('utm')).toBe('kept');
  });

  test('[url:dashboard.range] covers every mode/default/invalid/open bound and discrete push lifecycle', () => {
    for (const mode of ['all', 'today', '7d']) {
      const url = dashboardUrlFor(new URL('http://local/'), { ...defaults, range: { mode } }, codec);
      expect(parseDashboardSearchUrl(new URL(url), codec).range).toEqual({ mode });
    }
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, range: { mode: '30d' } }, codec).search).toBe('');
    const invalid = parseDashboardSearchUrl(
      new URL(
        'http://local/?range=%7B%22mode%22%3A%22custom%22%2C%22from%22%3A%222026-03-03%22%2C%22to%22%3A%222026-02-28%22%7D',
      ),
      codec,
    );
    expect(invalid.range).toEqual(defaults.range);
    for (const range of [
      { mode: 'custom', from: '2026-02-30' },
      { mode: 'custom', from: 'bad' },
      { mode: 'unsupported' },
    ]) {
      expect(codec.validate({ range }, defaults).range).toEqual(defaults.range);
    }
    const url = dashboardUrlFor(
      new URL('http://local/'),
      { ...defaults, range: { mode: 'custom', from: '2026-02-01' } },
      codec,
    );
    expect(parseDashboardSearchUrl(url, codec).range).toEqual({ mode: 'custom', from: '2026-02-01' });
    const toOnlyUrl = dashboardUrlFor(
      new URL('http://local/'),
      { ...defaults, range: { mode: 'custom', to: '2026-02-28' } },
      codec,
    );
    expect(parseDashboardSearchUrl(toOnlyUrl, codec).range).toEqual({ mode: 'custom', to: '2026-02-28' });
    const fixture = trackedNavigation();
    for (const mode of ['all', 'today', '7d', '30d', 'custom']) {
      fixture.navigate((current) => ({
        ...current,
        range: mode === 'custom' ? { mode, from: '2026-02-01' } : { mode },
      }));
    }
    expect(fixture.memory.entries()).toHaveLength(6);
    expect(fixture.intents.every((intent) => intent.replace === undefined && intent.resetScroll === false)).toBe(true);
  });

  test('[url:dashboard.time-cell] covers strict/default/all invalid variants and selection/removal pushes', () => {
    for (const cell of ['MON-00', 'SUN-23']) {
      expect(parseDashboardSearchUrl(new URL(`http://local/?timeCell=${cell}`), codec).timeCell).toBe(cell);
    }
    for (const query of [
      'timeCell=mon-04',
      'timeCell=MON-4',
      'timeCell=MON-24',
      'timeCell=MON-04x',
      'timeCell=MON-04&timeCell=TUE-05',
    ]) {
      expect(parseDashboardSearchUrl(new URL(`http://local/?${query}`), codec).timeCell).toBeUndefined();
    }
    expect(parseDashboardSearchUrl(new URL('http://local/'), codec).timeCell).toBeUndefined();
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, timeCell: 'MON-04' }));
    fixture.navigate(({ timeCell: _timeCell, ...current }) => current);
    expect(fixture.memory.entries()).toHaveLength(3);
    expect(fixture.memory.currentUrl().searchParams.get('utm')).toBe('kept');
    expect(fixture.memory.currentUrl().searchParams.has('timeCell')).toBe(false);
  });

  test('[url:dashboard.sort] covers all IDs/default/legacy/fallback and exact push lifecycle', () => {
    for (const id of sessionSchemaModule.sessionColumnIds) {
      const url = dashboardUrlFor(new URL('http://local/'), { ...defaults, sort: { desc: false, id } }, codec);
      expect(parseDashboardSearchUrl(url, codec).sort).toEqual({ desc: false, id });
    }
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, sort: defaults.sort }, codec).search).toBe('');
    expect(
      parseDashboardSearchUrl(
        new URL('http://local/?sort=%5B%7B%22id%22%3A%22fresh%22%2C%22desc%22%3Afalse%7D%5D'),
        codec,
      ).sort,
    ).toEqual({ desc: false, id: 'fresh' });
    expect(parseDashboardSearchUrl(new URL('http://local/?sort=%7B%22id%22%3A%22bad%22%7D'), codec).sort).toEqual(
      defaults.sort,
    );
    expect(parseDashboardSearchUrl(new URL('http://local/?sort=%7B%22id%22%3A%22fresh%22%7D'), codec).sort).toEqual({
      desc: defaults.sort.desc,
      id: 'fresh',
    });
    const fixture = trackedNavigation();
    fixture.navigate((current) => ({ ...current, sort: { desc: false, id: 'fresh' } }));
    expect(fixture.memory.entries()).toHaveLength(2);
    expect(parseDashboardSearchUrl(fixture.memory.currentUrl(), codec).sort).toEqual({ desc: false, id: 'fresh' });
  });

  test('[url:dashboard.columns] covers bases/default/legacy resolution/invalid IDs and replace lifecycle', () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?cols=%5B%22tokIn%22%5D'), codec)).toMatchObject({
      cols: ['tokIn'],
      colsBase: 'auto',
    });
    const url = dashboardUrlFor(new URL('http://local/'), { ...defaults, cols: ['tokIn'], colsBase: 'legacy' }, codec);
    expect(parseDashboardSearchUrl(url, codec)).toMatchObject({ cols: ['tokIn'], colsBase: 'legacy' });
    expect(parseDashboardSearchUrl(new URL('http://local/?colsBase=work'), codec).colsBase).toBe('work');
    expect(
      parseDashboardSearchUrl(new URL('http://local/?cols=%5B%22bad%22%2C%22tokIn%22%2C%22tokIn%22%5D'), codec).cols,
    ).toEqual(['tokIn']);
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, cols: [], colsBase: 'auto' }, codec).search).toBe(
      '',
    );
    expect(sessionSchemaModule.columnVisibilityFromDiff([], 'auto').machine).toBe(false);
    expect(sessionSchemaModule.columnVisibilityFromDiff(['tokIn'], 'auto').machine).not.toBe(false);
    const fixture = trackedNavigation('http://local/');
    fixture.navigate((current) => ({ ...current, cols: ['tokIn'] }), { replace: true, resetScroll: false });
    expect(fixture.memory.entries()).toHaveLength(1);
    expect(fixture.intents.at(-1)).toMatchObject({ replace: true, resetScroll: false });
  });
});
