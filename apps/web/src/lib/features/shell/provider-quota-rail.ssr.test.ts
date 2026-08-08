import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { buildProviderQuotaRail, type ProviderQuotaRailEntry } from './provider-quota-rail';

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Provider quota rail did not expose a Svelte component.');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());

const [railModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/shell/provider-quota-rail.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const ProviderQuotaRail = componentFrom(railModule);
const { render } = rendererFrom(svelteServerModule);

const NOW = '2026-08-07T12:00:00.000Z';

const measuredEntries = (): ProviderQuotaRailEntry[] =>
  buildProviderQuotaRail(
    {
      generatedAt: NOW,
      providers: [
        {
          generatedAt: NOW,
          key: 'codex',
          label: 'Codex',
          plan: 'Plus',
          source: 'live-api',
          state: 'ok',
          windows: [
            {
              blocked: false,
              group: '5h',
              id: '5h',
              label: '5h',
              limitSeconds: 18_000,
              remainingPercent: 29,
              resetsAt: '2026-08-07T16:40:00.000Z',
              scope: 'global',
              usedPercent: 71,
            },
          ],
        },
      ],
      schemaVersion: 1,
    },
    NOW,
  );

const renderRail = (entries: ProviderQuotaRailEntry[]): string =>
  render(ProviderQuotaRail, { props: { entries } }).body;

describe('rendered provider quota rail', () => {
  test('renders one slot per provider with the measured percentage in the first paint', () => {
    const html = renderRail(measuredEntries());

    expect(html).toContain('data-provider-quota-rail');
    for (const key of ['claude', 'codex', 'opencode', 'cursor']) {
      expect(html).toContain(`data-provider-quota="${key}"`);
    }
    expect(html).toContain('71%');
    expect(html).toContain('resets');
  });

  test('states which direction the percentage runs, in both the heading and each window', () => {
    const html = renderRail(measuredEntries());

    // A bare "71%" beside a ring is ambiguous: some providers publish what is left, not what is used.
    expect(html).toContain('Quota used');
    expect(html).toContain('29% left');
  });

  test('ships the detail flyout collapsed rather than absent, so hover has nothing to fetch', () => {
    const html = renderRail(measuredEntries());

    expect(html).toContain('data-quota-flyout');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="app-provider-quota"');
  });

  test('states the unmeasured providers instead of dropping them', () => {
    const html = renderRail(measuredEntries());

    expect(html).toContain('No quota source');
    expect(html).toContain('Claude');
    expect(html).toContain('Cursor');
  });

  test('gives up its rail slot entirely when no provider reports anything', () => {
    expect(renderRail(buildProviderQuotaRail(null, NOW))).not.toContain('data-provider-quota-rail');
  });
});
