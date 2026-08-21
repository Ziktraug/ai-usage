import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  parseSessionQueryRequest,
  type SessionPresentationRow,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
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

// The two units the scope label exists to keep apart: four campaign rows match the filters and two
// of them are loaded, and those four campaigns stand for seven filtered sessions. A fixture that
// reused one number for both would let the label swap the units without failing.
const LOADED_ROWS = 2;
const FILTERED_SESSIONS = 7;
const FILTERED_CAMPAIGN_ROWS = 4;
// Deliberately different per row, so "representing N sessions" cannot be satisfied by the row count.
const LOADED_VISIBLE_SESSIONS = [2, 3] as const;
const loadedCampaignRows = (): SessionPresentationRow[] =>
  Array.from({ length: LOADED_ROWS }, (_unused, index) => ({
    ...syntheticCampaignRow(index + 1),
    campaignVisibleCount: LOADED_VISIBLE_SESSIONS[index] ?? 1,
  }));
const queryData = (): SessionWindowQueryData => ({
  campaignChildren: [],
  campaignSessions: [],
  query: request,
  topLevel: {
    pageParams: [null],
    pages: [
      {
        itemCount: FILTERED_CAMPAIGN_ROWS,
        items: loadedCampaignRows().map((row, index) => ({
          campaignKey: row.campaignKey ?? `campaign-${index}`,
          kind: 'campaign' as const,
          row,
        })),
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
    expect(normalized).toContain(
      sessionsExportScopeLabel(loadedCampaignRows(), FILTERED_CAMPAIGN_ROWS, FILTERED_SESSIONS),
    );
    // The units have to stay distinct in the rendered text: 2 of 4 campaign rows loaded, standing
    // for 5 of 7 filtered sessions. Comparing a campaign-row count against a session total is the
    // exact confusion this label replaced.
    expect(normalized).toContain('2 of 4 campaign rows currently loaded');
    expect(normalized).toContain('representing 5 of 7 filtered sessions');
  });

  test('falls back to the loaded count before a page has reported a filtered total', () => {
    const normalized = renderDestination(undefined).replaceAll(/\s+/g, ' ');

    expect(normalized).toContain(sessionsExportScopeLabel([], 0, 0));
  });
});
