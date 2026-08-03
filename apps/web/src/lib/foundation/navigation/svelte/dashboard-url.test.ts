import { describe, expect, test } from 'bun:test';
import {
  createDashboardSearchNavigation,
  createSearchEditRun,
  type DashboardSearchCodec,
  dashboardUrlFor,
  parseDashboardSearchUrl,
} from './dashboard-url';
import { createMemoryNavigationPort } from './navigation';

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
  readonly validateDashboardSearch: (raw: Record<string, unknown>, defaults: DashboardFixture) => DashboardFixture;
}

// Keep Solid-only type dependencies outside Svelte's static closure while still
// exercising the frozen production parser at runtime.
const dashboardSearchModuleId: string = '../../../../dashboard-search';
const dashboardSearchModule = (await import(dashboardSearchModuleId)) as DashboardSearchModule;
const codec: DashboardSearchCodec<DashboardFixture> = {
  defaults: dashboardSearchModule.dashboardSearchDefaultsFor('date'),
  validate: dashboardSearchModule.validateDashboardSearch,
};
const { defaults } = codec;

describe('dashboard URL parity', () => {
  test('[url:dashboard.tab] preserves legacy tabs while stripping the overview default', () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?tab=providers'), codec).tab).toBe('providers');
    expect(dashboardUrlFor(new URL('http://local/?utm=x'), { ...defaults, tab: 'overview' }, codec).search).toBe(
      '?utm=x',
    );
    expect(
      dashboardUrlFor(new URL('http://local/?utm=x'), { ...defaults, tab: 'sessions' }, codec).searchParams.get('tab'),
    ).toBe('sessions');
  });

  test('[url:dashboard.breakdown-sort] canonicalizes strict values and strips value', () => {
    expect(parseDashboardSearchUrl(new URL('http://local/?breakdownSort=bad'), codec).breakdownSort).toBe('value');
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, breakdownSort: 'value' }, codec).search).toBe('');
    expect(
      dashboardUrlFor(new URL('http://local/'), { ...defaults, breakdownSort: 'tokens' }, codec).searchParams.get(
        'breakdownSort',
      ),
    ).toBe('tokens');
  });

  test('[url:dashboard.query] first edit pushes, continuing edit replaces, commit restarts the run', () => {
    const run = createSearchEditRun();
    expect(run.next()).toEqual({ replace: false, resetScroll: false });
    expect(run.next()).toEqual({ replace: true, resetScroll: false });
    run.commit();
    expect(run.next()).toEqual({ replace: false, resetScroll: false });
    const port = createMemoryNavigationPort('http://local/?utm=kept');
    const navigate = createDashboardSearchNavigation(port, codec);
    navigate((current) => ({ ...current, q: '  report  ' }), run.next());
    expect(port.currentUrl().searchParams.get('q')).toBe('report');
    expect(port.currentUrl().searchParams.get('utm')).toBe('kept');
  });

  test('[url:dashboard.harness] [url:dashboard.machine] accepts legacy scalars and emits unique arrays', () => {
    const parsed = parseDashboardSearchUrl(new URL('http://local/?harness=Codex&machine=work-laptop'), codec);
    expect(parsed.harness).toEqual(['Codex']);
    expect(parsed.machine).toEqual(['work-laptop']);
    const url = dashboardUrlFor(
      new URL('http://local/'),
      { ...defaults, harness: ['Codex'], machine: ['raw stale'] },
      codec,
    );
    expect(parseDashboardSearchUrl(url, codec)).toMatchObject({ harness: ['Codex'], machine: ['raw stale'] });
  });

  test('[url:dashboard.origin] keeps canonical order and strips the neutral all selection', () => {
    expect(
      parseDashboardSearchUrl(new URL('http://local/?origin=%5B%22unknown%22%2C%22human%22%5D'), codec).origin,
    ).toEqual(['human']);
    expect(dashboardUrlFor(new URL('http://local/'), { ...defaults, origin: [] }, codec).search).toBe('');
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
  });

  test('[url:dashboard.range] [url:dashboard.time-cell] validates bounds and strict cells', () => {
    const invalid = parseDashboardSearchUrl(
      new URL(
        'http://local/?range=%7B%22mode%22%3A%22custom%22%2C%22from%22%3A%222026-03-03%22%2C%22to%22%3A%222026-02-28%22%7D&timeCell=mon-4',
      ),
      codec,
    );
    expect(invalid.range).toEqual(defaults.range);
    expect(invalid.timeCell).toBeUndefined();
    const url = dashboardUrlFor(
      new URL('http://local/'),
      { ...defaults, range: { mode: 'custom', from: '2026-02-01' }, timeCell: 'MON-04' },
      codec,
    );
    expect(parseDashboardSearchUrl(url, codec)).toMatchObject({
      range: { mode: 'custom', from: '2026-02-01' },
      timeCell: 'MON-04',
    });
  });

  test('[url:dashboard.sort] [url:dashboard.columns] preserves legacy sort and visibility bases', () => {
    const parsed = parseDashboardSearchUrl(
      new URL('http://local/?sort=%5B%7B%22id%22%3A%22fresh%22%2C%22desc%22%3Afalse%7D%5D&cols=%5B%22tokIn%22%5D'),
      codec,
    );
    expect(parsed.sort).toEqual({ desc: false, id: 'fresh' });
    expect(parsed).toMatchObject({ cols: ['tokIn'], colsBase: 'auto' });
    const url = dashboardUrlFor(new URL('http://local/'), { ...defaults, cols: ['tokIn'], colsBase: 'legacy' }, codec);
    expect(parseDashboardSearchUrl(url, codec)).toMatchObject({ cols: ['tokIn'], colsBase: 'legacy' });
  });
});
