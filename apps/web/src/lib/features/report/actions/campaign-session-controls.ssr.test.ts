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

const child = syntheticSessionRow(2);
const hidden = syntheticSessionRow(3);
const campaign = {
  ...syntheticCampaignRow(1, [child, hidden]),
  campaignKey,
  campaignTotalCount: 3,
  campaignVisibleCount: 2,
};

describe('campaign session controls SSR', () => {
  test('renders counts, hidden-filter guidance, visible children, and scoped controls', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign,
        onClearCampaignFilter: () => undefined,
        onSelectSession: () => undefined,
        query: query(campaignKey),
        visibleRows: [campaign, child],
      },
    }).body;
    const normalizedHtml = html.replaceAll(/\s+/g, ' ');

    expect(html).toContain(`data-campaign-session-controls="${campaignKey}"`);
    expect(normalizedHtml).toContain('2 / 3 sessions shown');
    expect(normalizedHtml).toContain('1 hidden by current filters');
    expect(html).toContain(`data-campaign-session-row-id="${campaign.rowId}"`);
    expect(html).toContain(`data-campaign-session-row-id="${child.rowId}"`);
    expect(html).not.toContain(`data-campaign-session-row-id="${hidden.rowId}"`);
    expect(html).toContain('Show all campaign sessions');
    expect(html).toContain('Clear campaign filter');
  });

  test('does not duplicate a global clear action when the campaign filter is absent', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign,
        onClearCampaignFilter: () => undefined,
        onSelectSession: () => undefined,
        query: query(undefined),
        visibleRows: [campaign, child],
      },
    }).body;

    expect(html).toContain('Show all campaign sessions');
    expect(html).not.toContain('Clear campaign filter');
    expect(html).not.toContain('>Clear filters<');
  });
});
