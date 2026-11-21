import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

/**
 * The open, focus, dismissal, portal, reduced-motion and cleanup contracts of Drawer, Popover and
 * Tooltip are browser behaviour: `bun run --cwd packages/design-system test:browser` drives them in
 * system Chrome (overlays.browser.ts, ADR 0006's accepted exception), and the app's Session drawer
 * runs them in Playwright. What a server render can show is pinned here: the closed overlays leave
 * nothing but caller-owned, named triggers in the document.
 */
const repositoryDirectory = fileURLToPath(new URL('../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());

const [fixtureModule, rendererModule] = await Promise.all([
  viteServer.ssrLoadModule('/packages/design-system/src/svelte/overlays/overlay-fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = Reflect.get(fixtureModule, 'default') as Component;
const render = Reflect.get(rendererModule, 'render') as (component: Component) => { body: string };
const html = render(fixture).body.replaceAll(/<!--[^>]*-->/g, '');
const TOOLTIP_TARGET_PATTERN =
  /<button data-scope="tooltip" data-part="trigger"[^>]*type="button">Tooltip target<\/button>/;

const elementsWithScope = (scope: string): string[] =>
  [...html.matchAll(new RegExp(`<[a-z]+ [^>]*data-scope="${scope}"[^>]*>`, 'g'))].map(([element]) => element);

describe('Svelte overlay components during SSR', () => {
  test('a closed Drawer renders nothing: its content mounts only in the client portal', () => {
    expect(elementsWithScope('drawer')).toEqual([]);
    expect(html).not.toContain('Drawer fixture');
    expect(html).not.toContain('Persistent drawer fixture');
    expect(html).toContain('data-drawer-open="false"');
  });

  test('Popover renders only its named button trigger until it opens', () => {
    const [trigger, ...others] = elementsWithScope('popover');

    expect(others).toEqual([]);
    expect(trigger).toContain('data-part="trigger"');
    expect(trigger).toContain('type="button"');
    expect(trigger).toContain('aria-label="Open fixture popover"');
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(html).not.toContain('Popover fixture content');
  });

  test('Tooltip spreads its trigger props on the caller-owned element and renders no content until shown', () => {
    expect(elementsWithScope('tooltip')).toHaveLength(2);
    expect(html).toMatch(TOOLTIP_TARGET_PATTERN);
    expect(html).not.toContain('Tooltip fixture content');
    expect(html).not.toContain('data-part="content"');
  });

  test('a provenance cell names its fact on the marker trigger', () => {
    expect(html).toContain('<span>42 minutes</span>');
    expect(html).toContain('aria-label="Partial data: The provider omitted part of this interval."');
  });
});
