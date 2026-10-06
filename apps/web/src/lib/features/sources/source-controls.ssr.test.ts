import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

const DISABLED_ATTRIBUTE_PATTERN = /\sdisabled(?:[\s=>])/u;
const STATUS_LABEL_PATTERN = /data-source-summary-status="">Up to date<\/span>/u;

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

const renderedButton = (html: string, label: 'Run now'): string => {
  const buttonPattern = new RegExp(`<button\\b[^>]*>[\\s\\S]*?${label}[\\s\\S]*?<\\/button>`, 'u');
  const button = html.match(buttonPattern)?.[0];
  if (!button) {
    throw new Error(`Rendered ${label} button is missing.`);
  }
  return button;
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
  test('renders aria-busy on the run action while a command is pending', () => {
    const html = render(fixture, { props: { pending: true } }).body;
    const actions = fixtureBlock(html, 'actions');

    const runNow = renderedButton(actions, 'Run now');
    expect(runNow).toContain('aria-busy="true"');
    expect(DISABLED_ATTRIBUTE_PATTERN.test(runNow)).toBe(true);
  });

  test('stamps the engine snapshot generation next to the status the pill reports', () => {
    const summary = fixtureBlock(render(fixture, { props: { pending: false } }).body, 'summary');

    expect(summary).toContain('data-source-summary-generation="1"');
    expect(summary).toMatch(STATUS_LABEL_PATTERN);
  });

  test('renders only the compact trigger until collection details are opened', () => {
    const summary = fixtureBlock(render(fixture, { props: { pending: false } }).body, 'summary');
    expect(summary).toContain('aria-label="Collection status"');
    expect(summary).not.toContain('data-source-card');
    expect(summary).not.toContain('Collect now');
  });

  test('omits aria-busy from the run action while idle', () => {
    const html = render(fixture, { props: { pending: false } }).body;
    const actions = fixtureBlock(html, 'actions');

    const runNow = renderedButton(actions, 'Run now');
    expect(runNow).not.toContain('aria-busy');
    expect(DISABLED_ATTRIBUTE_PATTERN.test(runNow)).toBe(false);
  });
});
