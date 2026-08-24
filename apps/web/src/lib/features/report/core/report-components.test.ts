import { afterAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { projectFocusedSupport } from '@ai-usage/report-core/focused-report-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { demoReportPayload } from '../../../../report-data';
import { toWebReportPayload } from '../../../../web-report-payload';
import { createWebQueryClient, dehydrateWebQueryClient } from '../../../query/client';
import type { ReportQueryClient } from '../../../query/options/report';
import { reportBootstrapKey } from '../../../query/options/report';
import { acquireLiveReportQueryState } from './report-bootstrap';

const REPORT_FRESHNESS_PATTERN = /Data as of Jun 11, \d{2}:\d{2}/;

const liveAcquisitionOptions = () => ({
  fetch: () => Promise.reject(new Error('The injected report client owns this test acquisition')),
  pageUrl: new URL('http://report.invalid/'),
  url: new URL('http://report.invalid/'),
});

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
const [overviewModule, rootModule, workspaceModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/core/report-bootstrap-overview.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/core/report-root.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/core/report-workspace.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const overview = componentFrom(overviewModule, 'Report bootstrap overview');
const reportRoot = componentFrom(rootModule, 'Hydrated report root fixture');
const reportWorkspace = componentFrom(workspaceModule, 'Report workspace');
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

  it('renders the live report shell server-side from the awaited alias without a second bootstrap', async () => {
    let bootstrapCount = 0;
    const data = {
      mode: 'live',
      queryState: await acquireLiveReportQueryState(liveAcquisitionOptions(), {
        createClient: () =>
          reportClientFixture(compatiblePublication(), () => {
            bootstrapCount += 1;
          }),
      }),
    } as const;

    expect(data.queryState.dehydratedState.queries[0]?.queryKey).toEqual(reportBootstrapKey());
    const { body } = render(reportRoot, { props: { data } });
    expect(bootstrapCount).toBe(1);
    expect(body).toContain('<main');
    expect(body).toContain('data-route-shell="report"');
    // The live destination — not the bootstrap placeholder — is what the server now emits.
    expect(body).toContain('data-dashboard-filter-stack');
    expect(body).not.toContain('data-report-bootstrap-overview');
  });

  it('renders filters, period, active summary, then the Overview in decision order', () => {
    const queryClient = createWebQueryClient();
    const data = {
      mode: 'demo',
      payload: toWebReportPayload(demoReportPayload),
      queryState: dehydrateWebQueryClient(queryClient),
    } as const;

    const { body } = render(reportRoot, { props: { data } });
    const orderedSurfaces = [
      'data-dashboard-filter-stack',
      'data-report-period-control',
      'data-active-filters',
      'data-report-overview',
    ];
    const positions = orderedSurfaces.map((surface) => body.indexOf(surface));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(body).toContain('data-report-freshness');
    expect(body.replaceAll(/<[^>]*>/g, '')).toMatch(REPORT_FRESHNESS_PATTERN);
  });

  it('marks retained output as stale while a refresh is in flight', () => {
    // A range change rescales the Activity chart locally while every figure inside the workspace
    // still describes the previous request. Both must not read as equally definitive.
    const refreshing = render(reportWorkspace, { props: { hasOutput: true, pending: true } });
    expect(refreshing.body).toContain('data-report-stale="true"');
    expect(refreshing.body).toContain('aria-busy="true"');

    const settled = render(reportWorkspace, { props: { hasOutput: true, pending: false } });
    expect(settled.body).toContain('data-report-complete-output');
    expect(settled.body).not.toContain('data-report-stale');
    expect(settled.body).not.toContain('aria-busy');
  });

  it('keeps refresh failure recoverable without replacing retained output', () => {
    const failedRefresh = render(reportWorkspace, {
      props: {
        hasOutput: true,
        onRetry: () => Promise.resolve(),
        pending: false,
        refreshError: 'The report refresh failed.',
      },
    });

    expect(failedRefresh.body).toContain('data-report-complete-output');
    expect(failedRefresh.body).toContain('data-report-refresh-error');
    expect(failedRefresh.body).toContain('The report refresh failed.');
    expect(failedRefresh.body).toContain('>Retry</button>');
  });

  it('shows the pending surface rather than an unavailable panel while the first commit is missing', async () => {
    const data = {
      mode: 'live',
      queryState: await acquireLiveReportQueryState(liveAcquisitionOptions(), {
        createClient: () => reportClientFixture(compatiblePublication(), () => undefined),
      }),
    } as const;

    const { body } = render(reportRoot, { props: { data } });
    expect(body).toContain('data-report-pending');
    expect(body).not.toContain('data-report-unavailable');
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
});
