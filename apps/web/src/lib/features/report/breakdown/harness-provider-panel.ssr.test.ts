import { afterAll, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Harness/provider panel module did not expose a Svelte component');
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
const [componentModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const component = componentFrom(componentModule);
const { render } = rendererFrom(serverModule);

test('renders an expander only for harnesses with a real provider split', () => {
  const { body } = render(component, {
    props: {
      generatedAt: '2026-08-23T09:00:00.000Z',
      groups: [group('codex', { sessions: 3 }), group('opencode', { sessions: 4 })],
      harnessProviderGroups: [
        group('codex', { key: 'codex|Codex sub', provider: 'Codex sub', sessions: 3 }),
        group('opencode', { key: 'opencode|OpenAI API', provider: 'OpenAI API', sessions: 3 }),
        group('opencode', { key: 'opencode|Codex sub (OC)', provider: 'Codex sub (OC)', sessions: 1 }),
      ],
      onHarnessFilter: () => undefined,
      onProviderFilter: () => undefined,
      onSortChange: () => undefined,
      sort: 'value',
    },
  });
  expect(body).toContain('data-harness-total="codex"');
  expect(body).toContain('data-sole-provider="Codex sub"');
  expect(body).toContain('>· Codex sub</span>');
  expect(body).toContain('title="Only provider recorded for this harness — its figures are the harness figures"');
  expect(body).not.toContain('aria-label="Expand providers for codex"');
  expect(body).toContain('aria-label="Expand providers for opencode"');
  expect(body).not.toContain('data-provider-child=');
  expect(body).toContain('3 provider pairs');
});
