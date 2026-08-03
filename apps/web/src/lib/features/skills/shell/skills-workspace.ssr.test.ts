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
    throw new Error('Skills workspace fixture did not expose a Svelte component');
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
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);

const [fixtureModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-workspace.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(svelteServerModule);

describe('Svelte Skills workspace SSR', () => {
  test('renders a meaningful selected Global workspace without ClientOnly', () => {
    const html = render(fixture).body;
    expect(html).toContain('data-skills-workspace');
    expect(html).toContain('Global and project scopes');
    expect(html).toContain('alpha-skill');
    expect(html).toContain('Editable SKILL.md');
    expect(html).toContain('# Alpha synthetic document');
    expect(html).toContain('aria-label="Inspector"');
    expect(html).toContain('Health integration');
    expect(html).not.toContain('Loading skills');
  });

  test('renders nested Project selection and its settled read-only document', () => {
    const html = render(fixture, {
      props: { pathname: '/skills/projects/synthetic-group/project-review' },
    }).body;
    expect(html).toContain('project-review');
    expect(html).toContain('Project skill · read-only');
    expect(html).toContain('# Project synthetic document');
    expect(html).toContain('/skills/projects/synthetic-group/project-review');
  });

  test('exposes the management packet matrix slot without implementing it', () => {
    const html = render(fixture, { props: { pathname: '/skills/matrix' } }).body;
    expect(html).toContain('aria-label="Synthetic matrix slot"');
    expect(html).toContain('Matrix integration');
  });
});
