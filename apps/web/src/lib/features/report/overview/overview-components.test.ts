import { afterAll, describe, expect, test } from 'bun:test';
import { projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer } from 'vite';
import { toDateInputValue } from '../../../../date-range';
import type { ProviderStatusView } from '../../../../provider-status-model';
import { demoReportPayload } from '../../../../report-data';

const components = [
  'activity-heatmap.svelte',
  'activity-timeline.svelte',
  'dashboard-metrics.svelte',
  'overview-hero.svelte',
  'overview-page.svelte',
  'provider-status.svelte',
  'punchcard.svelte',
  'records.svelte',
  'session-shape.svelte',
  'source-freshness.svelte',
  'token-anatomy.svelte',
  '../range/report-range-control.svelte',
] as const;

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

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
const [fixtureModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/overview/overview-page.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(serverModule);

const focusedOverview = () => {
  const { rows, tableRows: _tableRows, ...support } = demoReportPayload;
  return projectFocusedOverview(rows, support, {
    includeAdvanced: true,
    query: {
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      range: { from: '2026-05-12T00:00:00.000Z', to: '2026-06-11T23:59:59.999Z' },
      revision: 'p2-fixture-revision',
    },
    timeline: { dimension: 'campaign', granularity: 'day' },
  });
};

describe('P2 Overview Svelte surfaces', () => {
  for (const component of components) {
    test(`compiles ${component} for server rendering`, async () => {
      const sourcePath = new URL(component, import.meta.url);
      const source = await Bun.file(sourcePath).text();
      const compiled = compile(source, {
        filename: sourcePath.pathname,
        generate: 'server',
        modernAst: true,
        runes: true,
      });
      expect(compiled.warnings.filter((warning) => warning.code !== 'css_unused_selector')).toEqual([]);
      expect(compiled.js.code.length).toBeGreaterThan(0);
    });
  }

  test('renders meaningful report content and all primary P2 regions during SSR', () => {
    const { body } = render(fixture, { props: { result: focusedOverview() } });

    expect(body).toContain('data-report-overview');
    expect(body).toContain('data-report-revision="p2-fixture-revision"');
    expect(body).toContain('Estimated API-equivalent value');
    expect(body).toContain('Value bases');
    expect(body).toContain('Token anatomy');
    expect(body).toContain('Provider status');
    expect(body).toContain('Rhythm');
    expect(body).toContain('Punchcard');
    expect(body).toContain('Campaign · Day · Estimated API-equivalent value');
    expect(body).toContain('data-series-key="');
    expect(body).toContain('background: hsl(');
    expect(body).toContain('data-punchcard-cell-fill');
    expect(body).not.toContain('Loading report');
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
    const todayKey = heatmap?.weeks.flatMap((week) => week.days).find((day) => day !== null)?.date;
    if (!(heatmap && todayKey)) {
      throw new Error('P2 fixture heatmap is missing a current-day candidate');
    }
    const result = {
      ...baseResult,
      view: { ...baseResult.view, heatmap: { ...heatmap, todayKey } },
    };
    const { body } = render(fixture, { props: { result } });
    const dayCount = body.match(/data-heatmap-day/g)?.length ?? 0;
    const rovingTargetCount = body.match(/data-heatmap-day[^>]*tabindex="0"/g)?.length ?? 0;

    expect(dayCount).toBeGreaterThan(20);
    expect(rovingTargetCount).toBe(1);
    expect(body).toContain('aria-current="date"');
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

  test('renders determined and indeterminate provider progress with remaining/reset copy', () => {
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
    expect(body).toContain('Remaining unknown');
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
