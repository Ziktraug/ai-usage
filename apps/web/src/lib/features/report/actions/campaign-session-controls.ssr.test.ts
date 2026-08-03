import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { syntheticCampaignRow, syntheticSessionRow } from '../../sessions/table/session-table.fixtures';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Campaign session controls fixture did not expose a Svelte component');
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
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/actions/campaign-session-controls.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const CampaignSessionControls = componentFrom(componentModule);
const { render } = rendererFrom(serverModule);

const campaignKey = 'machine-a:codex:root-a';
const query = (campaign: string | undefined): SessionQueryRequest => ({
  cursor: null,
  filters: { fields: campaign === undefined ? {} : { campaign }, harness: [], machine: [], query: '' },
  pageSize: 50,
  range: { from: null, to: null },
  revision: 'revision-campaign-controls',
  sort: [{ desc: true, id: 'date' }],
});

const root = syntheticSessionRow(1);
const child = syntheticSessionRow(2);
const hidden = syntheticSessionRow(3);
const campaign = {
  ...syntheticCampaignRow(1),
  campaignKey,
  campaignTotalCount: 4,
  campaignVisibleCount: 2,
  costApprox: 99,
};

describe('campaign session controls SSR', () => {
  test('renders truthful partial counts, actual session metrics, and existing P3 paging controls', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign,
        collection: { items: [root, child, hidden], loading: true, nextCursor: 'next-page', totalCount: 4 },
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: query(campaignKey),
        visibleRows: [root, child],
      },
    }).body;
    const normalizedHtml = html.replaceAll(/\s+/g, ' ');

    expect(html).toContain(`data-campaign-session-controls="${campaignKey}"`);
    expect(normalizedHtml).toContain('2 / 4 sessions match current filters');
    expect(normalizedHtml).toContain('3 / 4 sessions loaded');
    expect(normalizedHtml).toContain('2 hidden by current filters');
    expect(html).toContain(`data-campaign-session-row-id="${root.rowId}"`);
    expect(html).toContain(`data-campaign-session-row-id="${child.rowId}"`);
    expect(html).not.toContain(`data-campaign-session-row-id="${hidden.rowId}"`);
    expect(html).toContain('$0.10 API');
    expect(html).not.toContain('$99.00 API');
    expect(html).toContain('Show loaded campaign sessions');
    expect(html).toContain('Loading more campaign sessions…');
    expect(html).toContain('Clear campaign filter');
  });

  test('renders the exact campaign clear independently when a fully visible campaign hides nothing', () => {
    const fullyVisibleCampaign = { ...campaign, campaignTotalCount: 2, campaignVisibleCount: 2 };
    const html = render(CampaignSessionControls, {
      props: {
        campaign: fullyVisibleCampaign,
        collection: { items: [root, child], loading: false, nextCursor: null, totalCount: 2 },
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: query(campaignKey),
        visibleRows: [root, child],
      },
    }).body;

    expect(html.replaceAll(/\s+/g, ' ')).toContain('2 / 2 sessions shown');
    expect(html).toContain('Clear campaign filter');
    expect(html).not.toContain('Show all campaign sessions');
    expect(html).not.toContain('>Clear filters<');
  });

  test('does not duplicate a global clear action when the campaign filter is absent', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign,
        collection: { items: [root, child, hidden], loading: false, nextCursor: null, totalCount: 4 },
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: query(undefined),
        visibleRows: [root, child],
      },
    }).body;

    expect(html).toContain('Show all campaign sessions');
    expect(html).not.toContain('Clear campaign filter');
    expect(html).not.toContain('>Clear filters<');
  });
});
