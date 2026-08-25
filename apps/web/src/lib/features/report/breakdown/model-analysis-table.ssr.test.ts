import { afterAll, describe, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { modelAnalysisEmptyMessage } from './model';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Model Analysis table module did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const group = (key: string, overrides: Partial<AnalyticsGroup> = {}): AnalyticsGroup => ({
  ambiguous: 0,
  cache: 50,
  cacheHitPct: 25,
  costPer100Lines: null,
  costPercent: 60,
  costPerSession: null,
  costSum: 12,
  fresh: 100,
  harness: key,
  inp: 150,
  key,
  lineCount: 0,
  linesA: 0,
  linesD: 0,
  medianCost: null,
  priced: 1,
  provider: key,
  sessions: 1,
  tools: 0,
  turns: 0,
  unpriced: 0,
  unpricedFreshTokens: 0,
  usageUnavailable: 0,
  ...overrides,
});

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
const [componentModule, dashboardModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/breakdown/model-analysis-table.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const component = componentFrom(componentModule);
const dashboard = componentFrom(dashboardModule);
const { render } = rendererFrom(serverModule);

const columnLabels = [
  'Model',
  'API value',
  'Share',
  'Processed tokens',
  'Pricing coverage',
  'API value / 1M tokens',
] as const;
const TABLE_CAPTION_PATTERN = /<caption[^>]*>Model API-value analysis<\/caption>/;

describe('responsive Models analysis', () => {
  test('renders equivalent semantic desktop and mobile representations with visible provenance', () => {
    const groups = [
      group('measured'),
      group('partial', {
        cache: 50,
        costPercent: 15,
        costSum: 3,
        fresh: 50,
        priced: 1,
        sessions: 2,
        unpriced: 1,
        unpricedFreshTokens: 25,
      }),
      group('zero', { cache: 0, costPercent: 0, costSum: 0, fresh: 0 }),
      group('counterless', { costSum: 4, priced: 3, sessions: 3, usageUnavailable: 1 }),
    ];
    const { body } = render(component, {
      props: {
        generatedAt: '2026-08-09T12:00:00.000Z',
        groups,
        onModelFilter: () => undefined,
        onSortChange: () => undefined,
        sort: 'value',
      },
    });

    expect(body).toContain('data-breakdown-panel="models"');
    expect(body).toContain('data-model-analysis-table');
    expect(body).toContain('data-model-analysis-cards');
    expect(body.match(/scope="col"/g)).toHaveLength(columnLabels.length);
    expect(body.match(/scope="row"/g)).toHaveLength(groups.length);
    for (const label of columnLabels) {
      expect(body).toContain(`>${label}</th>`);
    }
    expect(body).toMatch(TABLE_CAPTION_PATTERN);
    expect(body).toContain('aria-label="Model API-value analysis"');
    expect(body).toContain('Known API-equivalent value divided by processed tokens');
    expect(body).toContain('an observed aggregate comparison, not a published model price');
    expect(body).toContain('cache read + cache write + input + output');
    expect(body).toContain('aria-label="Search this breakdown"');
    expect(body).toContain('aria-label="Sort breakdown"');
    expect(body).toContain('data-price-state="partially measured"');
    expect(body).toContain('Partially measured · 25 unpriced fresh tokens');
    expect(body).toContain('≥ $3.00');
    expect(body).toContain('aria-label="Filter sessions by model partial"');
    expect(body).toContain('<article aria-label="partial"');
    expect(body).toContain('API value / 1M tokens is unavailable because this model has zero processed tokens.');
    const coverageLabel = '3 / 3 · 100%';
    const coverageQualification = '1 of 3 sessions without token counters · API value is a lower bound';
    const coverageStart = body.indexOf(coverageLabel);
    const coverageCell = body.slice(coverageStart, body.indexOf('</td>', coverageStart));
    expect(coverageStart).toBeGreaterThan(-1);
    expect(coverageCell).toContain(coverageQualification);
    const mobileCards = body.slice(body.indexOf('data-model-analysis-cards'));
    expect(mobileCards).toContain('Processed tokens: cache read + cache write + input + output.');
    expect(mobileCards.match(new RegExp(coverageQualification, 'g'))).toHaveLength(1);
  });

  test('keeps the Breakdown route contract behind the visible Analysis dimension', () => {
    const { body } = render(dashboard, {
      props: {
        data: {
          cursorRows: [],
          generatedAt: '2026-08-09T12:00:00.000Z',
          harnesses: [],
          harnessProviders: [],
          models: [group('measured')],
          projects: [],
          range: { from: null, to: null },
        },
        navigation: {
          onSortChange: () => undefined,
          onTabChange: () => undefined,
          sort: 'value',
          tab: 'breakdown',
        },
        onFieldFilter: () => undefined,
        onHarnessFilter: () => undefined,
        projectEditor: {
          disabled: false,
          onSave: () => Promise.resolve(),
          payload: { projectGroupConfigs: [], projectGroups: [] },
        },
      },
    });

    expect(body).toContain('aria-label="Analysis dimension"');
    expect(body).toContain('data-breakdown-panel="models"');
    expect(body).not.toContain('aria-label="Breakdown dimension"');
  });

  test('preserves the exact local-search empty copy', () => {
    expect(modelAnalysisEmptyMessage(' model-without-results ')).toBe('No breakdown rows match this search');
    expect(modelAnalysisEmptyMessage('')).toBe('No models');
  });
});
