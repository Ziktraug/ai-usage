import { afterAll, describe, expect, test } from 'bun:test';
import { projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer } from 'vite';
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
  server: { hmr: false, middlewareMode: true, ws: false },
  ssr: { noExternal: true },
});
const [fixtureModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/overview/overview-page.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(serverModule);
afterAll(async () => viteServer.close());

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
