import { afterAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectFocusedSupport } from '@ai-usage/report-core/focused-report-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer } from 'vite';
import { demoReportPayload } from '../../../../report-data';
import { createWebQueryClient, dehydrateWebQueryClient } from '../../../query/client';
import type { ReportQueryClient } from '../../../query/options/report';
import { reportBootstrapKey } from '../../../query/options/report';
import { loadReportPageData } from './report-bootstrap';

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

const componentFrom = (loaded: unknown, label: string): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error(`${label} did not expose a Svelte component`);
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
const environmentFixture = fileURLToPath(new URL('./report-ssr-environment.fixture.ts', import.meta.url));
const navigationFixture = fileURLToPath(new URL('./report-ssr-navigation.fixture.ts', import.meta.url));
const stateFixture = fileURLToPath(new URL('./report-ssr-state.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: {
    alias: {
      '$app/environment': environmentFixture,
      '$app/navigation': navigationFixture,
      '$app/state': stateFixture,
    },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);
const [overviewModule, rootModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/core/report-bootstrap-overview.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/core/report-root.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const overview = componentFrom(overviewModule, 'Report bootstrap overview');
const reportRoot = componentFrom(rootModule, 'Hydrated report root fixture');
const { render } = rendererFrom(serverModule);

const compatiblePublication = (): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => {
  const { rows: _rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  return {
    bootstrap: projectFocusedSupport(
      reportSupport,
      { harness: ['claude-code'], machine: [{ label: 'Laptop', value: 'machine-a' }], truncated: false },
      { revision: 'compatible-last-revision' },
      { dateDomain: { first: '2026-07-01', last: '2026-08-01' } },
    ),
    manifest: {
      captureFingerprint: 'c'.repeat(64),
      expiresAt: 2,
      generatedAt: '2026-08-01T10:00:00',
      publishedAt: 1,
      revision: 'compatible-last-revision',
      rowsBytes: 1,
      supportBytes: 1,
    },
    ok: true,
    requestFingerprint: 'report-manifest:v1:{}',
  };
};

const reportClientFixture = (result: ReportRevisionBootstrapResult, onBootstrap: () => void): ReportQueryClient => {
  const unavailable = () => Promise.reject(new Error('Unexpected report query'));
  return {
    getFocusedReportBreakdown: unavailable,
    getFocusedReportOverview: unavailable,
    getFocusedReportSupport: unavailable,
    getReportRevisionBootstrap: () => {
      onBootstrap();
      return Promise.resolve(result);
    },
    getReportRevisionManifest: unavailable,
  };
};

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

  it('renders ReportRoot from the awaited dehydrated current alias without a second bootstrap', async () => {
    let bootstrapCount = 0;
    const data = await loadReportPageData(
      {
        fetch: () => Promise.reject(new Error('The injected report client owns this test acquisition')),
        mode: 'live',
        url: new URL('http://report.invalid/'),
      },
      {
        createClient: () =>
          reportClientFixture(compatiblePublication(), () => {
            bootstrapCount += 1;
          }),
      },
    );

    expect(data.queryState.dehydratedState.queries[0]?.queryKey).toEqual(reportBootstrapKey());
    const { body } = render(reportRoot, { props: { data } });
    expect(bootstrapCount).toBe(1);
    expect(body).toContain('<main');
    expect(body).toContain('data-route-shell="report"');
    expect(body).toContain('data-report-bootstrap-overview');
    expect(body).toContain('data-report-revision="compatible-last-revision"');
    expect(body).toContain('Compatible stored publication');
    expect(body).toContain('2026-07-01 – 2026-08-01');
    expect(body).not.toContain('Loading report');
  });

  it('renders the unavailable ReportRoot with normalized empty warnings', () => {
    const queryClient = createWebQueryClient();
    queryClient.setQueryData(reportBootstrapKey(), {
      error: { message: 'No compatible publication.', tag: 'RevisionUnavailable' },
      ok: false,
      requestFingerprint: 'report-manifest:v1:{}',
    } satisfies ReportRevisionBootstrapResult);
    const data = { mode: 'live', queryState: dehydrateWebQueryClient(queryClient) } as const;

    const { body } = render(reportRoot, { props: { data } });
    expect(body).toContain('Report payload unavailable');
    expect(body).toContain('data-report-unavailable');
    expect(body).not.toContain('Report warnings');
  });

  it('locks definitive output while preserving requested context during a pending refresh', async () => {
    const source = await readFile(new URL('./report-workspace.svelte', import.meta.url), 'utf8');
    expect(source.indexOf('{#if pending}')).toBeLessThan(source.indexOf('{:else if hasOutput}'));
    expect(source).toContain('data-report-complete-output');
    expect(source).toContain('{@render pendingContext(pending)}');
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
