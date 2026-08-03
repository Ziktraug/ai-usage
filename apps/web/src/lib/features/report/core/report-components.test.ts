import { afterAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer } from 'vite';

const components = [
  'report-bootstrap-overview.svelte',
  'report-header.svelte',
  'report-pending-surface.svelte',
  'report-root.svelte',
  'report-status.svelte',
  'report-warnings.svelte',
  'report-workspace.svelte',
] as const;

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Report bootstrap overview did not expose a Svelte component');
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
const [overviewModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/core/report-bootstrap-overview.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const overview = componentFrom(overviewModule);
const { render } = rendererFrom(serverModule);
afterAll(async () => viteServer.close());

describe('report Svelte SSR components', () => {
  for (const component of components) {
    it(`compiles ${component} for server rendering`, async () => {
      const sourcePath = new URL(component, import.meta.url);
      const source = await readFile(sourcePath, 'utf8');
      const compiled = compile(source, {
        filename: sourcePath.pathname,
        generate: 'server',
        modernAst: true,
        runes: true,
      });
      expect(compiled.warnings.filter((warning) => warning.code !== 'css_unused_selector')).toEqual([]);
      expect(compiled.js.code.length).toBeGreaterThan(0);
    });
  }

  it('renders meaningful successful and compatible-last publication HTML during SSR', () => {
    const { body } = render(overview, {
      props: {
        items: [
          { label: 'Coverage', value: '2026-07-01 – 2026-08-01' },
          { label: 'Machines', value: '2' },
        ],
        publicationLabel: 'Compatible stored publication',
        revision: 'compatible-last-revision',
      },
    });

    expect(body).toContain('data-report-bootstrap-overview');
    expect(body).toContain('data-report-revision="compatible-last-revision"');
    expect(body).toContain('Overview');
    expect(body).toContain('Compatible stored publication');
    expect(body).toContain('2026-07-01 – 2026-08-01');
    expect(body).toContain('Machines');
  });

  it('retains complete output while a destination refresh is pending', async () => {
    const source = await readFile(new URL('./report-workspace.svelte', import.meta.url), 'utf8');
    expect(source.indexOf('{#if hasOutput}')).toBeLessThan(source.indexOf('{:else if pending}'));
    expect(source).toContain('data-report-complete-output');
    expect(source).toContain('<ReportStatus {pending} {refreshError} />');
    expect(source).not.toContain('aria-live="polite" class={panel}');
  });

  it('keeps an explicit warning cleanup action seam for P8', async () => {
    const source = await readFile(new URL('./report-warnings.svelte', import.meta.url), 'utf8');
    expect(source).toContain('onCleanupProjectWarning');
    expect(source).toContain('cleaningProjectWarningGroupId');
    expect(source).toContain("'Cleaning…' : 'Cleanup'");
  });
});
