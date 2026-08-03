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
    throw new Error('Source controls fixture did not expose a Svelte component.');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
  }
  return loaded as SvelteServerModule;
};

const fixtureBlock = (html: string, fixture: 'actions' | 'summary'): string => {
  const start = html.indexOf(`data-source-${fixture}-fixture`);
  if (start < 0) {
    throw new Error(`Rendered source ${fixture} fixture is missing.`);
  }
  const nextFixture = fixture === 'actions' ? html.indexOf('data-source-summary-fixture', start + 1) : -1;
  return html.slice(start, nextFixture < 0 ? undefined : nextFixture);
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

const [fixtureModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sources/source-controls.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(svelteServerModule);

describe('rendered source-control pending semantics', () => {
  test('renders aria-busy on both run actions while a command is pending', () => {
    const html = render(fixture, { props: { pending: true } }).body;
    const actions = fixtureBlock(html, 'actions');
    const summary = fixtureBlock(html, 'summary');

    expect(actions).toContain('Run now');
    expect(actions).toContain('aria-busy="true"');
    expect(summary).toContain('Run all');
    expect(summary).toContain('aria-busy="true"');
  });

  test('omits aria-busy from both run actions while idle', () => {
    const html = render(fixture, { props: { pending: false } }).body;
    const actions = fixtureBlock(html, 'actions');
    const summary = fixtureBlock(html, 'summary');

    expect(actions).toContain('Run now');
    expect(actions).not.toContain('aria-busy');
    expect(summary).toContain('Run all');
    expect(summary).not.toContain('aria-busy');
  });
});
