import { afterAll, expect, test } from 'bun:test';
import type { FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
import { apiPriceMeasurement } from '@ai-usage/report-core/provenance';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const AGGREGATE_ENTRY_PATTERN = /data-timeline-legend-entry="aggregate"[\s\S]*?<\/li>/;
const FLEX_AGGREGATE_ENTRY_PATTERN = /<li class="[^"]*d_flex[^"]*" data-timeline-legend-entry="aggregate">/;

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Activity timeline did not expose a Svelte component.');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
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
afterAll(() => viteServer.close());

const [componentModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/overview/activity-timeline.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const component = componentFrom(componentModule);
const { render } = rendererFrom(serverModule);

const measurement = apiPriceMeasurement({ costKnown: true, freshTokens: 7800, knownCost: 78 });
const series = Array.from({ length: 12 }, (_, index) => ({
  key: index === 11 ? '__ai_usage_other__' : `model-${index + 1}`,
  label: index === 11 ? 'Other' : `Model ${index + 1}`,
  ...(index === 11
    ? {
        memberKeys: ['model-12', 'model-13'],
        memberSummaries: [
          { label: 'Model 12', sessions: 1, total: 1 },
          { label: 'Model 13', sessions: 1, total: 1 },
        ],
      }
    : {}),
  priceMeasurement: measurement,
  sessions: 1,
  tokens: 100,
  total: index + 1,
}));
const timeline: FocusedTimelineData = {
  buckets: [
    {
      byKey: Object.fromEntries(
        series.map((item) => [item.key, { cost: item.total, priceMeasurement: measurement, sessions: 1, tokens: 100 }]),
      ),
      date: '2026-06-11',
      priceMeasurement: measurement,
      sessions: 12,
      tokens: 1200,
      total: 78,
      unclassified: null,
    },
  ],
  dimension: 'model',
  first: '2026-06-11',
  grandSessions: 12,
  grandTokens: 1200,
  grandTotal: 78,
  granularity: 'day',
  last: '2026-06-11',
  maxBucketSessions: 12,
  maxBucketTokens: 1200,
  maxBucketTotal: 78,
  priceMeasurement: measurement,
  series,
  unclassified: null,
};

test('renders twelve ranked model entries with a neutral inline grouped tail', () => {
  const { body } = render(component, { props: { timeline, value: 'cost' } });
  const swatchClassFor = (key: string): string => {
    const match = body.match(new RegExp(`data-series-key="${key}"[\\s\\S]*?<span aria-hidden="true" class="([^"]+)"`));
    return match?.[1] ?? '';
  };
  const modelSwatches = series.slice(0, -1).map((item) => swatchClassFor(item.key));
  const otherSwatch = swatchClassFor('__ai_usage_other__');

  expect(modelSwatches.every((className) => className.includes('bg_chart.c'))).toBeTrue();
  expect(new Set(modelSwatches).size).toBe(11);
  expect(modelSwatches[0]).toContain('bg_chart.c3');
  expect(modelSwatches[1]).toContain('bg_chart.c2');
  expect(otherSwatch).toContain('bg_lineStrong');
  expect(otherSwatch).not.toContain('bg_chart.c');
  expect(body).toMatch(FLEX_AGGREGATE_ENTRY_PATTERN);
  const aggregateEntry = body.match(AGGREGATE_ENTRY_PATTERN)?.[0] ?? '';
  expect(aggregateEntry.indexOf('</button>')).toBeLessThan(aggregateEntry.indexOf('2 grouped'));
});
