import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { parseSessionQueryRequest, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { sessionsExportScopeLabel } from '../../../../dashboard-breakdown-export';
import { dashboardSearchDefaultsFor } from '../../../../dashboard-search';
import { initialSessionWindowIntent, type SessionWindowQueryData } from '../../../query/options/session-window';
import { syntheticCampaignRow } from '../../sessions/table/session-table.fixtures';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('The sessions destination fixture did not expose a Svelte component');
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

const [componentModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/composition/sessions-destination.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const SessionsDestinationFixture = componentFrom(componentModule);
const { render } = rendererFrom(serverModule);

const search = dashboardSearchDefaultsFor('date');
const request = parseSessionQueryRequest({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 200,
  range: { from: null, to: null },
  revision: 'revision-sessions-export',
  sort: [{ desc: true, id: 'date' }],
});
const { cursor: _cursor, revision: _revision, ...destinationScope } = request;

// Two loaded rows out of seven that match the filters: the gap the scope label exists to state.
const LOADED_ROWS = 2;
const FILTERED_SESSIONS = 7;
const queryData = (): SessionWindowQueryData => ({
  campaignChildren: [],
  campaignSessions: [],
  query: request,
  topLevel: {
    pageParams: [null],
    pages: [
      {
        itemCount: FILTERED_SESSIONS,
        items: Array.from({ length: LOADED_ROWS }, (_, index) => {
          const row = syntheticCampaignRow(index + 1);
          return { campaignKey: row.campaignKey ?? `campaign-${index}`, kind: 'campaign' as const, row };
        }),
        nextCursor: 'sq1.0000000000000000.1',
        requestFingerprint: sessionQueryFingerprint(request),
        revision: request.revision,
        sessionCount: FILTERED_SESSIONS,
      },
    ],
  },
});

const noop = (): undefined => undefined;
const renderDestination = (data: SessionWindowQueryData | undefined): string =>
  render(SessionsDestinationFixture, {
    props: {
      destination: {
        destinationScope,
        generatedAt: '2026-08-20T18:45:00.000Z',
        initialSessionWindowAnchor: false,
        navigate: noop,
        onCampaignControlsChange: noop,
        onIncreaseQueryDepth: noop,
        onInitialSessionWindowAnchor: noop,
        onRowsChange: noop,
        onSelectionChange: noop,
        onSessionCountChange: noop,
        pending: false,
        presentRow: (row: unknown) => row,
        queryData: data,
        queryIntent: initialSessionWindowIntent(),
        search,
        selectedCampaignKey: undefined,
        selectedRowId: null,
      },
    },
  }).body;

describe('sessions destination export actions SSR', () => {
  test('offers the sharing actions on Sessions and names the loaded and filtered counts', () => {
    const html = renderDestination(queryData());
    const normalized = html.replaceAll(/\s+/g, ' ');

    expect(html).toContain('data-sessions-export');
    expect(html).toContain('data-report-sharing-actions');
    expect(normalized).toContain('Export CSV');
    // Campaign rows are not flattened into the destination row list, so the CSV
    // carries the aggregate and never a second copy of a child session — stated
    // as visible text, not a tooltip only a mouse can reach.
    expect(normalized).toContain(sessionsExportScopeLabel(LOADED_ROWS, FILTERED_SESSIONS));
    expect(normalized).toContain('campaigns as one aggregated row');
  });

  test('falls back to the loaded count before a page has reported a filtered total', () => {
    const normalized = renderDestination(undefined).replaceAll(/\s+/g, ' ');

    expect(normalized).toContain(sessionsExportScopeLabel(0, 0));
  });
});
