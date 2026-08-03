import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer } from 'vite';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('The session table fixture did not expose a Svelte component');
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
  plugins: [...svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, ws: false },
  ssr: { noExternal: true },
});
const [fixtureModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sessions/table/session-table.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(serverModule);
afterAll(async () => viteServer.close());

describe('session table Svelte rendering', () => {
  test('compiles the responsive table and its concrete fixture without warnings', async () => {
    for (const file of ['session-table.svelte', 'session-table-owner.svelte', 'session-table.fixture.svelte']) {
      const sourcePath = new URL(file, import.meta.url);
      const source = await readFile(sourcePath, 'utf8');
      const compiled = compile(source, {
        filename: sourcePath.pathname,
        generate: 'server',
        modernAst: true,
        runes: true,
      });
      expect(compiled.warnings.filter(({ code }) => code !== 'css_unused_selector')).toEqual([]);
      expect(compiled.js.code.length).toBeGreaterThan(0);
    }
  });

  test('server-renders meaningful table semantics, sorting, columns, and a bounded desktop window', () => {
    const { body } = render(fixture);

    expect(body).toContain('data-session-table-owner');
    expect(body).toContain('data-session-surface="desktop"');
    expect(body).not.toContain('data-session-surface="mobile"');
    expect(body).toContain('<table');
    expect(body).toContain('aria-rowcount="5000"');
    expect(body).toContain('aria-sort="descending"');
    expect(body).toContain('Session column presets');
    expect(body).toContain('Synthetic session 1');
    expect(body).toContain('Expand campaign Synthetic session 1');
    expect(body).toContain('data-session-row-id');
    expect(body).toContain('<mark');
    expect(body).toContain('Campaign · 1 session');
    expect(body).toContain('+ 1 automated review · 1,200 fresh');
    expect(body).toContain('data-session-provenance');
    expect(body).toContain('aria-pressed="false"');
    expect(body).toContain('title="Filter by synthetic-project"');
    expect(body).toContain('title="Filter by gpt-5.4"');
    expect(body.match(/data-session-row-id/g)?.length ?? 0).toBeLessThan(40);
  });

  test('server-renders the exact fixed mobile geometry and a bounded window from 5,000 actual rows', () => {
    const { body } = render(fixture, { props: { mode: 'mobile' } });

    expect(body).toContain('data-session-surface="mobile"');
    expect(body).not.toContain('data-session-surface="desktop"');
    expect(body).toContain('aria-setsize="5000"');
    expect(body).toContain('data-session-list-gap="0"');
    expect(body).toContain('data-session-list-padding="0"');
    expect(body).toContain('data-session-row-height="188"');
    expect(body).toContain('data-session-card-height="180"');
    expect(body).toContain('data-session-row-id');
    expect(body).toContain('data-depth="0"');
    expect(body).toContain('data-session-paging-sentinel="mobile"');
    expect(body).toContain('tabindex="0"');
    expect(body).toContain('aria-label="Inspect session: Synthetic session 1"');
    expect(body).toContain('title="Filter by project synthetic-project"');
    expect(body).toContain('title="Filter by model gpt-5.4"');
    expect(body).toContain('title="Expand campaign"');
    expect(body).toContain('root-session time');
    expect(body).toContain(
      'Campaign time uses the root session only. Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime.',
    );
    expect(body.match(/data-session-row-id/g)?.length ?? 0).toBeLessThan(24);
  });

  test('renders unavailable mobile hints and expanded aria set size from the full row model', () => {
    const unavailable = render(fixture, { props: { mode: 'mobile', unavailable: true } }).body;
    expect(unavailable).toContain('title="Session found in prompt history; detailed local token counters are missing"');
    const expanded = render(fixture, { props: { expanded: true, mode: 'mobile' } }).body;
    expect(expanded).toContain('aria-setsize="5001"');
    expect(expanded).toContain('data-depth="1"');
    expect(expanded).toContain('title="Collapse campaign"');
  });

  test('keeps one responsive owner and both fixed-geometry projections in the source contract', async () => {
    const source = await readFile(new URL('./session-table.svelte', import.meta.url), 'utf8');
    expect(source).toContain('let mode = $state<SessionSurfaceMode>');
    expect(source).toContain("mode === 'mobile' ? 'mobile' : 'desktop'");
    expect(source).toContain('data-session-paging-sentinel="mobile"');
    expect(source).toContain('data-virtual-spacer="top"');
    expect(source).toContain('data-virtual-spacer="bottom"');
    expect(source).toContain("event.key === 'ArrowDown'");
    expect(source).toContain("event.key !== 'ArrowUp'");
  });

  test('wires incremental revision recovery through the sole P1 lifecycle owner', async () => {
    const source = await readFile(new URL('./session-table-owner.svelte', import.meta.url), 'utf8');
    expect(source).toContain('query.setRevisionRefresh');
    expect(source).toContain('lifecycle.refresh({ scope })');
  });
});
