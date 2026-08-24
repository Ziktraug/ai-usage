import { afterAll, describe, expect, test } from 'bun:test';
import { projectFocusedBreakdown, projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { toDateInputValue } from '../../../../date-range';
import type { ProviderStatusView } from '../../../../provider-status-model';
import { demoReportPayload } from '../../../../report-data';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const RECORD_DISCLOSURE_PATTERN = /aria-hidden="true" class="[^"]+">↗<\/span>/;
/** The share `<span>` and value `<strong>` of one "API value by harness" row. */
const HARNESS_GROUP_SHARE_PATTERN = />([\d.]+%|—)<\/span> <strong/u;
const HARNESS_GROUP_VALUE_PATTERN = /<strong[^>]*>([^<]+)<\/strong>/u;

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Overview fixture did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = new URL('../../../../../../../', import.meta.url).pathname;
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);
const [fixtureModule, harnessPanelModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/overview/overview-page.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const harnessPanel = componentFrom(harnessPanelModule);
const { render } = rendererFrom(serverModule);

const focusedOverview = (
  range: { readonly from: string; readonly to: string } = {
    from: '2026-05-12T00:00:00.000Z',
    to: '2026-06-11T23:59:59.999Z',
  },
) => {
  const { rows, tableRows: _tableRows, ...support } = demoReportPayload;
  return projectFocusedOverview(rows, support, {
    includeAdvanced: true,
    query: {
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      range,
      revision: 'p2-fixture-revision',
    },
    timeline: { dimension: 'campaign', granularity: 'day' },
  });
};

describe('decision-first Overview Svelte surfaces', () => {
  test('renders exact ISO guidance on both custom period fields', () => {
    const body = render(fixture, {
      props: {
        range: { from: '2026-05-12', mode: 'custom', to: '2026-06-11' },
        result: focusedOverview(),
      },
    }).body;

    expect(body.match(/title="Date as YYYY-MM-DD"/g)).toHaveLength(2);
  });

  test('renders the provisional comparison caveat only for a period still in progress', () => {
    const today = focusedOverview({
      from: '2026-06-11T00:00:00.000Z',
      to: '2026-06-11T23:59:59.999Z',
    });
    const todayBody = render(fixture, { props: { range: { mode: 'today' }, result: today } }).body;
    const completeBody = render(fixture, { props: { result: focusedOverview() } }).body;

    expect(today.view.previousSummary?.totalCost).toBeGreaterThan(0);
    expect(todayBody).toContain('data-period-comparison-caveat');
    expect(todayBody).toContain('This period is still in progress, so the comparison is provisional.');
    expect(completeBody).not.toContain('data-period-comparison-caveat');
  });

  test('renders the executive answer before evidence and investigation during SSR', () => {
    const result = focusedOverview();
    const { body } = render(fixture, { props: { result } });

    expect(body).toContain('data-report-overview');
    expect(body).toContain('data-report-revision="p2-fixture-revision"');
    expect(body).toContain('data-executive-kpi');
    expect(body).toContain('data-executive-chart');
    expect(body).toContain('data-executive-metrics');
    expect(body).toContain('Estimated API-equivalent value');
    expect(body).toContain('This estimate covers work in the last 30 days.');
    expect(body).toContain('API value by harness');
    expect(body).toContain('Processed tokens');
    expect(body).toContain('Cache volume');
    expect(body).toContain('Output tokens');
    expect(body).toContain('Pricing coverage');
    expect(body).toContain('Open Analysis');
    expect(body).not.toContain('Value bases');
    expect(body).not.toContain('Reported actual spend');
    expect(body).not.toContain('Actual recorded cost');
    expect(body).not.toContain('Subscription value');
    expect(body).toContain('Token anatomy');
    expect(body).not.toContain('Provider status');
    expect(body).toContain('Rhythm');
    expect(body).toContain('Punchcard');
    expect(body).toContain('Campaign · Day · Estimated API-equivalent value');
    expect(body).toContain('data-series-key="');
    expect(body).toContain('background: hsl(');
    expect(body).toContain('data-punchcard-cell-fill');
    expect(body).toContain('Campaign · 3 sessions');
    expect(body).not.toContain('3 campaign sessions');
    expect(body).not.toContain('Loading report');

    const readingOrder = [
      'data-executive-kpi',
      'data-executive-chart',
      'data-executive-metrics',
      'Open Analysis',
      'Investigate',
      'Top sessions',
      'Rhythm',
      'Token anatomy',
      'Advanced analysis',
    ].map((marker) => body.indexOf(marker));
    expect(readingOrder.every((position) => position >= 0)).toBe(true);
    expect(readingOrder).toEqual([...readingOrder].sort((left, right) => left - right));
    expect(body).not.toContain('>Top session</span>');
    for (const item of result.view.topSessions) {
      expect(body).toContain(`Open details for ${item.label}.`);
    }
    const firstTopSession = result.view.topSessions[0];
    if (!firstTopSession) {
      throw new Error('Expected the Overview fixture to include a top session');
    }
    expect(body.split(`Open details for ${firstTopSession.label}.`).length - 1).toBe(1);
    expect(body).toContain('Open activity for');
    expect(body).not.toContain('aria-label="Open details for');
    expect(body).toMatch(RECORD_DISCLOSURE_PATTERN);

    // "Longest session" is a recorded duration whose meaning is harness-specific and,
    // for a campaign, root-session only (plan 052). The card must say which.
    const longest = result.view.records?.longest;
    if (!longest) {
      throw new Error('Expected the Overview fixture to include a longest session');
    }
    const expectedSemantic =
      longest.kind === 'campaign' && longest.sessionCount > 1 ? 'Root task-open time' : 'Task-open time';
    expect(body).toContain('data-longest-session-semantic');
    const normalizedBody = body.replaceAll(/\s+/g, ' ');
    expect(normalizedBody).toContain(`${longest.label} · ${expectedSemantic}`);
    expect(normalizedBody).toContain('Build report UI · Root task-open time');
    expect(body).toContain(
      'title="Campaign time uses the root session only. Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime."',
    );
  });

  test('distinguishes no local data from a filtered zero result', () => {
    const emptyResult = focusedOverview();
    const summary = {
      ...emptyResult.summary,
      cacheRead: 0,
      cacheWrite: 0,
      fresh: 0,
      meanCost: 0,
      pricedSessions: 0,
      priceMeasurement: { knownCost: 0, state: 'measured' as const, unpricedFreshTokens: 0 },
      sessionCount: 0,
      tokIn: 0,
      tokOut: 0,
      tools: 0,
      totalCost: 0,
      turns: 0,
    };
    const result = {
      ...emptyResult,
      summary,
      view: {
        ...emptyResult.view,
        executive: { harnesses: [], models: [] },
        topSessions: [],
      },
    };

    const noLocal = render(fixture, { props: { result, totalSessionCount: 0 } }).body;
    const filtered = render(fixture, { props: { result, totalSessionCount: 12 } }).body;

    expect(noLocal).toContain('No local usage yet');
    expect(noLocal).toContain('Open Sources');
    expect(noLocal).not.toContain('Clear filters');
    expect(filtered).toContain('No sessions match these filters');
    expect(filtered).toContain('Clear filters');
    expect(filtered).not.toContain('Open Sources');
  });

  test('retains campaign-shaped series identities and does not relabel human roots as subagents', () => {
    const result = focusedOverview();
    expect(result.timeline?.dimension).toBe('campaign');
    expect(result.timeline?.series.some((series) => series.label === 'Build report UI')).toBe(true);
    expect(result.timeline?.series.some((series) => series.label === 'Human')).toBe(false);
    expect(result.view.topSessions.some((item) => item.kind === 'campaign')).toBe(true);
  });
});

const quotaWindow = (overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow => ({
  blocked: false,
  group: 'weekly',
  id: 'weekly',
  label: 'Weekly',
  limitSeconds: 604_800,
  remainingPercent: 25,
  resetsAt: '2026-06-15T12:00:00.000Z',
  scope: 'provider',
  usedPercent: 75,
  ...overrides,
});

const providerView = (
  key: string,
  window: ProviderLimitWindow,
  overrides: Partial<ProviderStatusView> = {},
): ProviderStatusView => ({
  accountContext: 'Pro plan',
  creditsSummary: null,
  machineContext: null,
  nextResetAt: window.resetsAt,
  provider: {
    generatedAt: '2026-06-11T12:00:00.000Z',
    key,
    label: key === 'codex' ? 'Codex' : 'Claude',
    source: 'live-api',
    state: 'ok',
    windows: [window],
  },
  sourceLabel: 'Live status',
  tone: 'ok',
  windowGroups: [{ key: 'weekly', label: 'Weekly', windows: [window] }],
  worstUsedPercent: window.usedPercent,
  ...overrides,
});

describe('P2 corrected interactive SSR contracts', () => {
  test('renders all heatmap cells as one roving collection with today and price provenance', () => {
    const baseResult = focusedOverview();
    const heatmap = baseResult.view.heatmap;
    const todayDay = heatmap?.weeks.flatMap((week) => week.days).find((day) => day !== null);
    if (!(heatmap && todayDay)) {
      throw new Error('P2 fixture heatmap is missing a current-day candidate');
    }
    const todayKey = toDateInputValue(new Date(todayDay.date));
    const result = {
      ...baseResult,
      view: {
        ...baseResult.view,
        heatmap: {
          ...heatmap,
          todayKey,
          weeks: heatmap.weeks.map((week) => ({
            ...week,
            days: week.days.map((day) => (day?.date === todayDay.date ? { ...day, sessions: 1 } : day)),
          })),
        },
      },
    };
    const { body } = render(fixture, { props: { result } });
    const dayCount = body.match(/data-heatmap-day/g)?.length ?? 0;
    const rovingTargetCount = body.match(/data-heatmap-day[^>]*tabindex="0"/g)?.length ?? 0;
    const todayButton = body.match(new RegExp(`<button[^>]*data-heatmap-day="${todayKey}"[^>]*>`))?.[0] ?? '';

    expect(dayCount).toBeGreaterThan(20);
    expect(rovingTargetCount).toBe(1);
    expect(body.match(/aria-current="date"/g)).toHaveLength(1);
    expect(todayButton).toContain('tabindex="0"');
    expect(todayButton).toContain('aria-current="date"');
    expect(todayButton).toContain('1 session');
    expect(todayButton).not.toContain('1 sessions');
    expect(body).toContain('data-price-state=');
    expect(body).toContain('data-heatmap-readout');
  });

  test('preserves a local heatmap calendar day when its timestamp crosses the UTC boundary', () => {
    const baseResult = focusedOverview();
    const seedDay = baseResult.view.heatmap?.weeks.flatMap((week) => week.days).find((day) => day !== null);
    if (!seedDay) {
      throw new Error('P2 fixture heatmap is missing a local-day seed');
    }
    const serializedLocalMidnight = new Date(2026, 4, 25).toISOString();
    const expectedLocalDateKey = toDateInputValue(new Date(serializedLocalMidnight));
    const result = {
      ...baseResult,
      view: {
        ...baseResult.view,
        heatmap: {
          monthLabels: ['May'],
          todayKey: expectedLocalDateKey,
          weeks: [{ days: [{ ...seedDay, date: serializedLocalMidnight }] }],
        },
      },
    };
    const { body } = render(fixture, { props: { result } });

    expect(body).toContain(`data-heatmap-day="${expectedLocalDateKey}"`);
  });

  test('renders determined and indeterminate provider progress with reset copy and full aria semantics', () => {
    const determined = quotaWindow();
    const unknown = quotaWindow({
      id: 'unknown',
      label: 'Unknown window',
      remainingPercent: null,
      resetsAt: null,
      usedPercent: null,
    });
    const { body } = render(fixture, {
      props: {
        providers: [providerView('codex', determined), providerView('claude', unknown)],
        result: focusedOverview(),
      },
    });

    expect(body.match(/<progress/g)).toHaveLength(2);
    expect(body).toContain('value="75"');
    expect(body).toContain('Unknown usage');
    expect(body).not.toContain('Remaining unknown');
    expect(body).toContain('Reset time unknown');
    expect(body).toContain('unknown used percent, unknown remaining percent, reset time unknown');
  });

  test('renders Session Shape, advanced summary, and injected campaign language', () => {
    const baseResult = focusedOverview();
    const seed = baseResult.view.topSessions[0];
    if (!seed) {
      throw new Error('P2 fixture is missing a Session Shape seed');
    }
    const result = {
      ...baseResult,
      view: {
        ...baseResult.view,
        advancedSummary: { hasPunchcard: true, hasSessionShape: true, summary: 'Shape and rhythm ready' },
        sessionShape: {
          harnesses: [seed.harness],
          harnessSummaries: [],
          outliers: [seed],
          points: [{ ...seed, aggregateCount: 1 }],
          totalPoints: 1,
          xDomain: { max: 6, min: 0 },
          xTicks: [{ label: '1m', value: 60_000 }],
          yDomain: { max: 3, min: -3 },
          yTicks: [{ label: '00241', value: 1 }],
        },
      },
    };
    const { body } = render(fixture, {
      props: {
        presentCampaignSeries: (series: { key: string; label: string }) => ({
          ...series,
          label: `Renamed ${series.label}`,
        }),
        presentSessionItem: (item: { kind: string; label: string }) =>
          item.kind === 'campaign' ? { ...item, label: 'Renamed campaign' } : item,
        result,
      },
    });

    expect(body).toContain('Advanced analysis');
    expect(body).toContain('Session shape');
    expect(body).toContain('data-session-shape-point');
    expect(body).toContain('Renamed campaign');
    expect(body).toContain('Renamed Build report UI');
  });

  test('renders pressed legend filters and explicit stale/current machine presentation seam', () => {
    const result = focusedOverview();
    if (!result.timeline?.series[0]) {
      throw new Error('P2 fixture timeline is missing a series');
    }
    const key = result.timeline.series[0].key;
    const machineResult = {
      ...result,
      timeline: { ...result.timeline, dimension: 'machine' as const },
    };
    const { body } = render(fixture, {
      props: {
        activeSeriesKeys: [key],
        machineFreshnessStatus: 'Freshness unavailable',
        presentMachineSeries: (machineKey: string, label: string) => ({
          freshness: machineKey === key ? 'stale' : 'fresh',
          label: `${label} · ${machineKey === key ? 'Stale' : 'Current'}`,
        }),
        result: machineResult,
      },
    });

    expect(body).toContain('aria-pressed="true"');
    expect(body).toContain('data-machine-freshness="stale"');
    expect(body).toContain('· Stale');
    expect(body).toContain('Freshness unavailable');
  });
});

describe('U02 — one API-value total per harness across Overview and Analysis', () => {
  // The audit symptom: a harness whose sessions are partly priced showed a larger total on
  // Overview than in Harnesses & providers, because the breakdown counted only fully priced
  // sessions. Both surfaces must render the same known subtotal and the same share.
  const partiallyPricedFixture = () => {
    const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
    const base = {
      activeDate: '2026-06-05T10:00:00.000Z',
      calls: 1,
      costQuota: 0,
      date: '2026-06-05T09:00:00.000Z',
      durationMs: 60_000,
      endDate: '2026-06-05T10:00:00.000Z',
      harness: 'Codex',
      lineDelta: 0,
      linesAdded: 0,
      linesDeleted: 0,
      origin: 'human' as const,
      project: 'ai-usage',
      provider: 'Codex API',
      subagent: false,
      tokCw: 0,
      tools: 1,
      turns: 1,
    };
    const rows = [
      {
        ...base,
        costActual: 3,
        costApprox: 3,
        costKnown: true,
        freshTokens: 100,
        model: 'gpt-5.3-codex',
        name: 'Fully priced session',
        sessionLabel: 'Fully priced session',
        source: {
          harnessKey: 'codex',
          machineId: 'fixture-machine',
          machineLabel: 'Fixture Machine',
          rootSourceSessionId: 'priced',
          sourceSessionId: 'priced',
        },
        tokCr: 0,
        tokIn: 100,
        tokOut: 0,
        tokenTotal: 100,
      },
      {
        ...base,
        // Partly priced: one segment has a known $2 subtotal, the other has no pricing at all.
        // Before the fix the breakdown dropped this $2 while the Overview kept it.
        costActual: null,
        costApprox: 2,
        costKnown: false,
        freshTokens: 200,
        model: 'gpt-5.3-codex',
        modelSegments: [
          { costApprox: 2, costKnown: true, model: 'gpt-5.3-codex', tokCr: 0, tokCw: 0, tokIn: 100, tokOut: 0 },
          { costApprox: 0, costKnown: false, model: 'mystery-model', tokCr: 0, tokCw: 0, tokIn: 100, tokOut: 0 },
        ],
        models: ['gpt-5.3-codex', 'mystery-model'],
        name: 'Partly priced session',
        sessionLabel: 'Partly priced session',
        source: {
          harnessKey: 'codex',
          machineId: 'fixture-machine',
          machineLabel: 'Fixture Machine',
          rootSourceSessionId: 'partial',
          sourceSessionId: 'partial',
        },
        tokCr: 0,
        tokIn: 200,
        tokOut: 0,
        tokenTotal: 200,
      },
      {
        // A second, fully priced harness so the two surfaces divide by different denominators
        // when they disagree — the 24% vs 23% half of U02.
        ...base,
        costActual: 5,
        costApprox: 5,
        costKnown: true,
        freshTokens: 100,
        harness: 'Claude',
        model: 'claude-opus-4-6',
        name: 'Claude session',
        provider: 'Anthropic',
        sessionLabel: 'Claude session',
        source: {
          harnessKey: 'claude',
          machineId: 'fixture-machine',
          machineLabel: 'Fixture Machine',
          rootSourceSessionId: 'claude-session',
          sourceSessionId: 'claude-session',
        },
        tokCr: 0,
        tokIn: 100,
        tokOut: 0,
        tokenTotal: 100,
      },
    ];
    const query = {
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      range: { from: null, to: null },
      revision: 'u02-fixture-revision',
    };
    return {
      breakdown: projectFocusedBreakdown(rows, support, { query }),
      overview: projectFocusedOverview(rows, support, {
        includeAdvanced: false,
        query,
        timeline: { dimension: 'harness', granularity: 'day' },
      }),
    };
  };

  /** The value and share the Overview's "API value by harness" list renders for one harness. */
  const overviewHarnessTotal = (body: string, harness: string): { share: string; value: string } => {
    const section = body.slice(body.indexOf('API value by harness'));
    const item = section
      .split('<li')
      .find((fragment) => fragment.includes(`>${harness}<`) && fragment.includes('<strong'));
    if (item === undefined) {
      throw new Error(`Expected the Overview to render an "API value by harness" row for ${harness}`);
    }
    const share = HARNESS_GROUP_SHARE_PATTERN.exec(item);
    const value = HARNESS_GROUP_VALUE_PATTERN.exec(item);
    if (!(share?.[1] && value?.[1])) {
      throw new Error(`Expected the Overview ${harness} row to render a value and a share`);
    }
    return { share: share[1], value: value[1] };
  };

  test('renders the same Codex total and share on Overview and in Harnesses & providers', () => {
    const { breakdown, overview } = partiallyPricedFixture();

    const overviewBody = render(fixture, { props: { result: overview } }).body;
    const breakdownBody = render(harnessPanel, {
      props: {
        generatedAt: overview.metadata.generatedAt,
        groups: breakdown.groups.harnesses,
        harnessProviderGroups: breakdown.groups.harnessProviders,
        onHarnessFilter: () => undefined,
        onProviderFilter: () => undefined,
        onSortChange: () => undefined,
        sort: 'value',
      },
    }).body;

    const overviewHarness = overviewHarnessTotal(overviewBody, 'Codex');
    const harnessSection = breakdownBody.slice(breakdownBody.indexOf('data-harness-total="Codex"'));
    if (!harnessSection.startsWith('data-harness-total="Codex"')) {
      throw new Error('Expected the harness breakdown to render a Codex section');
    }

    const codexRow = harnessSection.slice(0, harnessSection.indexOf('</section>'));

    // Codex is $3 fully priced + the $2 known subtotal of the partly priced session, so both
    // surfaces read >= $5.00. Before the fix the breakdown dropped the $2 and rendered >= $3.00.
    expect(overviewHarness.value).toBe('≥ $5.00');
    expect(codexRow).toContain('≥ $5.00');
    expect(codexRow).not.toContain('$3.00');

    // Both shares divide by the same known subtotal ($5 Codex + $5 Claude), so Codex is half of
    // it on both surfaces. Before the fix the breakdown divided $3 by a fully-priced-only $8.
    expect(overviewHarness.share).toBe('50%');
    expect(codexRow).toContain('50%');
    expect(codexRow).not.toContain('38%');
  });
});
