import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}
const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Management fixture did not expose a Svelte component');
  }
  return loaded.default as Component;
};
const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};
const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const navigationFixturePath = fileURLToPath(new URL('../shell/sveltekit-navigation.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { alias: { '$app/navigation': navigationFixturePath }, conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());
const [fixtureModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/management/management.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(svelteServerModule);

describe('Svelte Skills management SSR', () => {
  test('renders individually named diagnostics and authoritative installation context', () => {
    const html = render(fixture).body;
    expect(html).toContain('data-skills-management-health-slot');
    expect(html).toContain('Finding 1: warning');
    expect(html).toContain('Skill document token warning');
    expect(html.replace(/\s+/gu, ' ')).toContain('1,240 / 1,000 tokens');
    expect(html).toContain('Installed in');
    expect(html).toContain('Not linked');
    expect(html).toContain('Disable');
    expect(html).not.toContain('SkillMarkdownTokenWarning');
  });

  test('renders the responsive matrix, filters, reconcile action, and both projections from settled data', () => {
    const html = render(fixture, { props: { pathname: '/skills/matrix' } }).body;
    expect(html).toContain('data-skills-management-matrix-slot');
    expect(html).toContain('Managed skills — exposure per runtime');
    expect(html).toContain('aria-label="Managed skills by runtime"');
    expect(html).toContain('<table');
    expect(html).toContain('Reconcile all…');
    expect(html).toContain('alpha-skill');
    expect(html).toContain('beta-skill');
    expect(html).toContain('Not linked');
    expect(html).toContain('Disabled');
  });

  test('renders neutral unmanaged backlog without invoking a filesystem or RPC client', () => {
    const html = render(fixture, { props: { pathname: '/skills/global' } }).body;
    expect(html).toContain('data-consolidation-panel');
    expect(html).toContain('data-backlog-tone="neutral"');
    expect(html).toContain('legacy-local-copy');
    expect(html).toContain('Nothing is ever deleted automatically.');
    expect(html).toContain('Review consolidation');
  });
});
