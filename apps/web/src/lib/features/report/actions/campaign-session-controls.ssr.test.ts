import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { SessionWindowView } from '../../../query/options/session-window';
import { syntheticCampaignRow, syntheticSessionRow } from '../../sessions/table/session-table.fixtures';
import { campaignSessionControlsState } from './campaign-session-controls-model';

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
// An automated review that both the in-memory campaign and the served rollup page can list.
const listedClassifier = { ...syntheticSessionRow(4), origin: 'classifier' as const };

/** Position of `marker`, refusing to return -1 so an ordering check cannot pass on two absences. */
const positionOf = (html: string, marker: string): number => {
  const position = html.indexOf(marker);
  if (position < 0) {
    throw new Error(`Expected the rendered campaign controls to contain ${marker}`);
  }
  return position;
};

/** The counts line only, so a match can never come from the member list below it. */
const countsLine = (html: string): string => {
  const normalized = html.replaceAll(/\s+/g, ' ');
  const start = positionOf(normalized, 'data-campaign-session-counts');
  const end = positionOf(normalized, 'data-campaign-session-list');
  if (end <= start) {
    throw new Error('Expected the campaign counts line to precede the member list');
  }
  return normalized.slice(start, end);
};
// Every header value is deliberately unlike the sum of the listed members, so re-deriving any
// one of the four from the member page instead of the campaign row fails loudly.
const campaign = {
  ...syntheticCampaignRow(1),
  campaignKey,
  campaignTotalCount: 4,
  campaignVisibleCount: 2,
  costApprox: 99,
  freshTokens: 777_000,
  tools: 3131,
  turns: 4242,
};
const CAMPAIGN_HEADER_TOTALS = '$99.00 API · 777k fresh tokens · 4,242 turns · 3,131 tools';
/** What the header would read if it re-aggregated `root` + `child` instead of the campaign row. */
const MEMBER_PAGE_TOTALS = ['2,003 fresh', '7 turns', '3 tools'] as const;

describe('campaign session controls SSR', () => {
  test('keeps filtered counts truthful when the production adapter includes a rolled-up review', () => {
    const filteredCampaign = {
      ...campaign,
      campaignClassifierCount: 1,
      campaignTotalCount: 2,
      campaignVisibleCount: 1,
    };
    const filteredQuery: SessionQueryRequest = {
      ...query(undefined),
      filters: { ...query(undefined).filters, origin: ['human', 'subagent'] },
    };
    const ownerState = {
      campaignChildren: new Map([
        [
          campaignKey,
          {
            items: [listedClassifier],
            loading: false,
            nextCursor: null,
            root,
            sessionCount: 0,
            totalCount: 1,
          },
        ],
      ]),
      campaignSessions: new Map([
        [
          campaignKey,
          {
            items: [listedClassifier],
            loading: false,
            nextCursor: null,
            root,
            sessionCount: 1,
            totalCount: 1,
          },
        ],
      ]),
      itemCount: 1,
      items: [{ campaignKey, kind: 'campaign' as const, row: filteredCampaign }],
      loadingMore: false,
      nextCursor: null,
      query: filteredQuery,
      sessionCount: 1,
    } satisfies SessionWindowView;
    const state = campaignSessionControlsState(ownerState, filteredCampaign);
    if (!state) {
      throw new Error('Expected the production campaign controls adapter to return state');
    }
    expect(state.rolledUpClassifierCount).toBe(1);

    const html = render(CampaignSessionControls, {
      props: {
        campaign: filteredCampaign,
        collection: state.collection,
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: ownerState.query,
        rolledUpClassifierCount: state.rolledUpClassifierCount,
        visibleRows: state.visibleRows,
      },
    }).body;
    const renderedCounts = countsLine(html);

    expect(html).toContain(`data-campaign-session-row-id="${root.rowId}"`);
    expect(html).toContain(`data-campaign-session-row-id="${listedClassifier.rowId}"`);
    expect(renderedCounts).toContain('1 / 2 sessions match current filters');
    expect(renderedCounts).toContain('+ 1 automated review included in campaign totals');
    expect(renderedCounts).not.toContain('hidden by current filters');
  });

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
    // All four header values come from the campaign row, appear exactly once, and sit in the
    // header above the member list — which never restates the aggregate.
    const normalizedForTotals = html.replaceAll(/\s+/g, ' ');
    expect(normalizedForTotals).toContain(CAMPAIGN_HEADER_TOTALS);
    expect(normalizedForTotals.split(CAMPAIGN_HEADER_TOTALS).length - 1).toBe(1);
    for (const memberTotal of MEMBER_PAGE_TOTALS) {
      expect(normalizedForTotals).not.toContain(memberTotal);
    }
    expect(positionOf(html, 'data-campaign-totals')).toBeLessThan(positionOf(html, '$99.00 API'));
    expect(positionOf(html, '$99.00 API')).toBeLessThan(positionOf(html, 'data-campaign-session-list'));
    expect(html).toContain('Show loaded campaign sessions');
    expect(html).toContain('Loading more campaign sessions…');
    expect(html).toContain('Clear campaign filter');
  });

  test('names only the rolled-up automated reviews the member list does not show', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign: { ...campaign, campaignClassifierCount: 2 },
        collection: { items: [root, child], loading: false, nextCursor: null, totalCount: 4 },
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: query(campaignKey),
        visibleRows: [root, child],
      },
    }).body;

    // Neither review is listed, so both are what makes the totals exceed the list.
    expect(html).not.toContain(`data-campaign-session-row-id="${listedClassifier.rowId}"`);
    expect(countsLine(html)).toContain('+ 2 automated reviews');
  });

  test('drops the automated-review suffix for a review that is itself one of the listed rows', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign: { ...campaign, campaignClassifierCount: 1, campaignVisibleCount: 3 },
        collection: { items: [root, child, listedClassifier], loading: false, nextCursor: null, totalCount: 3 },
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: query(campaignKey),
        visibleRows: [root, child, listedClassifier],
      },
    }).body;

    // The one review IS one of the three rows on screen, so nothing is unaccounted for.
    expect(html).toContain(`data-campaign-session-row-id="${listedClassifier.rowId}"`);
    expect(countsLine(html)).toContain('3 / 3 sessions shown');
    expect(countsLine(html)).not.toContain('automated review');
  });

  test('counts only the reviews beyond the listed ones when the list shows some of them', () => {
    const html = render(CampaignSessionControls, {
      props: {
        campaign: { ...campaign, campaignClassifierCount: 3, campaignVisibleCount: 3 },
        collection: { items: [root, child, listedClassifier], loading: false, nextCursor: null, totalCount: 3 },
        onClearCampaignFilter: () => undefined,
        onLoadMoreCampaignSessions: () => undefined,
        onSelectSession: () => undefined,
        query: query(campaignKey),
        visibleRows: [root, child, listedClassifier],
      },
    }).body;

    // Three reviews roll into the totals, one of them is on screen, so two are unaccounted for.
    expect(html).toContain(`data-campaign-session-row-id="${listedClassifier.rowId}"`);
    expect(countsLine(html)).toContain('+ 2 automated reviews');
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
