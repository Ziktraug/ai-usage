import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('P9 editor fixture did not expose a Svelte component');
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
afterAll(async () => await viteServer.close());

const [fixtureModule, slotModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/editor/editor.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/editor/skills-editor-slot.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(svelteServerModule);

describe('P9 Svelte Skills editor SSR', () => {
  test('compiles the shipped slot and renders settled meaningful editor HTML', () => {
    expect(componentFrom(slotModule)).toBeTypeOf('function');
    const html = render(fixture).body;
    expect(html).toContain('data-skill-markdown-editor');
    expect(html).toContain('aria-label="alpha-skill SKILL.md"');
    expect(html).toContain('# Alpha synthetic editor');
    expect(html).toContain('Saved');
    expect(html).toContain('Save');
    expect(html).toContain('Revert changes');
    expect(html).toContain('Reload from disk');
    expect(html).not.toContain('Discard unsaved changes?');
  });

  test('preserves an exact draft and exposes conflict and pending replacement semantics', () => {
    const html = render(fixture, { props: { mode: 'conflict', showDialog: true } }).body;
    expect(html).toContain('# Exact synthetic draft');
    expect(html).toContain('Changed on disk');
    expect(html).toContain('role="alert"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Discard unsaved changes?');
    expect(html).toContain('Keep editing');
    expect(html).toContain('Discard changes');
    expect(html).toContain('Synthetic pending draft decision.');
  });

  test('renders loading and dirty status without a client-only blank surface', () => {
    expect(render(fixture, { props: { mode: 'loading' } }).body).toContain('Loading…');
    const dirtyHtml = render(fixture, { props: { mode: 'dirty' } }).body;
    expect(dirtyHtml).toContain('Unsaved changes');
    expect(dirtyHtml).toContain('# Exact synthetic draft');
  });
});
