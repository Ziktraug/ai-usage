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
  test('renders the page-level operation host without drawing any facts of its own', () => {
    const html = render(fixture).body;

    expect(html).toContain('data-skills-management-health-slot');
    // The worktable carries every fact now; this host exists for refresh, reconcile, and notices.
    expect(html).not.toContain('data-inspector-section');
    expect(html).not.toContain('Installed in');
    expect(html).not.toContain('data-skill-summary-band');
  });

  test('shows no reconcile plan until one has been previewed', () => {
    const html = render(fixture).body;

    // Nothing is written before the plan is readable, so a settled render offers no Apply button.
    expect(html).not.toContain('data-skills-reconcile-plan');
    expect(html).not.toContain('Apply 1 action');
  });
});
