import { describe, expect, test } from 'bun:test';
import { projectFocusedSupport } from '@ai-usage/report-core/focused-report-query';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionLookupRequest,
  parseSessionQueryRequest,
  projectSessionCampaignChildren,
  projectSessionLookup,
  projectSessionPage,
  type SessionCampaignChildrenResult,
  type SessionLookupRequest,
  type SessionLookupResult,
  type SessionPageResult,
  sessionRowIdentity,
} from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { ORPCError } from '@orpc/client';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { QueryObserver } from '@tanstack/svelte-query';
import {
  campaignMapFixtureGeneratedAt,
  campaignMapFixtureRootKey,
  campaignMapFixtureRows,
} from '../../../campaign-map-fixture';
import { demoReportPayload } from '../../../report-data';
import { createHydratedWebQueryClient } from '../../query/client';
import { campaignLabelOverridesKey, campaignLabelOverridesQueryOptions } from '../../query/options/report';
import { sessionLookupKey, sessionLookupQueryOptions } from '../../query/options/session';
import { createWebRpcClient } from '../../rpc/client';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { loadCampaignsPageData } from './campaigns-load';

const revision = 'campaign-ssr-revision';
const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
const root = campaignMapFixtureRows[0];
const child = campaignMapFixtureRows[1];
if (!(root && child?.source)) {
  throw new Error('Campaign SSR fixture needs a root and a child');
}
const rows = [
  root,
  ...Array.from({ length: 150 }, (_, index) => ({
    ...child,
    activeDate: new Date(Date.parse(child.endDate!) + index * 60_000).toISOString(),
    date: new Date(Date.parse(child.date!) + index * 60_000).toISOString(),
    endDate: new Date(Date.parse(child.endDate!) + index * 60_000).toISOString(),
    source: { ...child.source!, sourceSessionId: `ssr-child-${String(index).padStart(3, '0')}` },
  })),
];
const farRow = rows.at(-1)!;
const farRowId = sessionRowIdentity(farRow);
const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
const bootstrap: Extract<ReportRevisionBootstrapResult, { readonly ok: true }> = {
  bootstrap: projectFocusedSupport(support, { harness: ['codex'], machine: [], truncated: false }, { revision }),
  manifest: {
    captureFingerprint: 'c'.repeat(64),
    expiresAt: 2,
    generatedAt: campaignMapFixtureGeneratedAt,
    publishedAt: 1,
    revision,
    rowsBytes: 1,
    supportBytes: 1,
  },
  ok: true,
  requestFingerprint: 'report-manifest:v1:{}',
};

const CAMPAIGN_LABELS_UNAVAILABLE = 'Campaign labels are temporarily unavailable.';

const ssrFixture = (
  rowId: string,
  { labelOverrides = 'available' }: { labelOverrides?: 'available' | 'unavailable' } = {},
) => {
  const url = new URL('http://campaign-ssr.invalid/campaigns?range=all');
  url.searchParams.set('selectedCampaign', campaignMapFixtureRootKey);
  url.searchParams.set('selectedSession', rowId);
  const lookups: SessionLookupRequest[] = [];
  const paths: string[] = [];
  const memberPages: number[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    paths.push(pathname);
    let result: unknown;
    if (pathname === '/rpc/report/revisionBootstrap') {
      result = bootstrap;
    } else if (pathname === '/rpc/campaign/labelOverrides') {
      if (labelOverrides === 'unavailable') {
        const unavailable = new ORPCError('SERVICE_UNAVAILABLE', { message: CAMPAIGN_LABELS_UNAVAILABLE });
        return Response.json(serializer.serialize(unavailable.toJSON()), { status: unavailable.status });
      }
      result = { campaignLabelOverrides: [] };
    } else {
      const input = serializer.deserialize(await request.json());
      let data: SessionPageResult | SessionCampaignChildrenResult | SessionLookupResult;
      if (pathname === '/rpc/session/page') {
        data = projectSessionPage(rows, parseSessionQueryRequest(input));
      } else if (pathname === '/rpc/session/campaignChildren') {
        data = projectSessionCampaignChildren(rows, parseSessionCampaignChildrenRequest(input));
        memberPages.push(data.items.length);
      } else if (pathname === '/rpc/session/lookup') {
        const parsed = parseSessionLookupRequest(input);
        lookups.push(parsed);
        data = projectSessionLookup(rows, parsed);
      } else {
        throw new Error(`SSR must not acquire native detail or unrelated data: ${pathname}`);
      }
      result = { data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision };
    }
    return Response.json(serializer.serialize(result));
  };
  return {
    lookups,
    memberPages,
    options: { rpc: createWebRpcClient({ fetch, url: new URL('/rpc', url) }), url },
    paths,
  };
};

const dehydratedLabelOverrides = (data: Awaited<ReturnType<typeof loadCampaignsPageData>>) =>
  data.queryState.dehydratedState.queries.filter(
    (query) => JSON.stringify(query.queryKey) === JSON.stringify(campaignLabelOverridesKey()),
  );

describe('Campaign session metadata SSR', () => {
  test('hydrates one far session lookup and reuses its exact identity without a browser request', async () => {
    const fixture = ssrFixture(farRowId);
    const data = await loadCampaignsPageData(fixture.options, 'live');
    const request = { revision, rowId: farRowId };
    expect(fixture.lookups).toEqual([request]);
    expect(fixture.memberPages).toEqual([100]);
    expect(fixture.paths).not.toContain('/rpc/session/detail');
    expect(fixture.paths.filter((path) => path === '/rpc/session/page')).toHaveLength(1);
    expect(
      data.queryState.dehydratedState.queries.filter(
        (query) => JSON.stringify(query.queryKey) === JSON.stringify(sessionLookupKey(request)),
      ),
    ).toHaveLength(1);

    const hydrated = createHydratedWebQueryClient(data.queryState);
    let browserReads = 0;
    const forbidden = (): Promise<never> => {
      browserReads += 1;
      return Promise.reject(new Error('The browser must reuse SSR metadata'));
    };
    const client: SessionClientAdapter = {
      campaignChildren: forbidden,
      detail: forbidden,
      lookup: forbidden,
      neighbors: forbidden,
      page: forbidden,
      vcs: forbidden,
    };
    const options = sessionLookupQueryOptions(client, request, { browser: true });
    const observer = new QueryObserver(hydrated, options);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const result = await hydrated.fetchQuery(options);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('Expected hydrated session metadata');
      }
      expect(result.revision).toBe(revision);
      expect(result.data.row?.rowId).toBe(farRowId);
      expect(browserReads).toBe(0);
      expect(observer.getCurrentResult().isFetching).toBe(false);
    } finally {
      unsubscribe();
      hydrated.clear();
    }
  });

  test.each([sessionRowIdentity(root), sessionRowIdentity(rows[1]!)])(
    'does not look up an already acquired member %s',
    async (rowId) => {
      const fixture = ssrFixture(rowId);
      await loadCampaignsPageData(fixture.options, 'live');
      expect(fixture.lookups).toEqual([]);
      expect(fixture.memberPages).toEqual([100]);
    },
  );

  test('hydrates the saved campaign labels when they can be read', async () => {
    const fixture = ssrFixture(sessionRowIdentity(root));
    const data = await loadCampaignsPageData(fixture.options, 'live');

    expect(dehydratedLabelOverrides(data)).toHaveLength(1);
  });

  test('renders without the saved campaign labels and leaves them to the browser when they cannot be read', async () => {
    const fixture = ssrFixture(sessionRowIdentity(root), { labelOverrides: 'unavailable' });

    // Labels are optional data: the page still loads, with every required read hydrated.
    const data = await loadCampaignsPageData(fixture.options, 'live');
    expect(fixture.paths).toContain('/rpc/campaign/labelOverrides');
    expect(fixture.memberPages).toEqual([100]);
    // The failure is not dehydrated, so the browser's labels query starts empty and requests the
    // labels itself; its error is what the page reports beside the derived titles.
    expect(dehydratedLabelOverrides(data)).toEqual([]);

    const hydrated = createHydratedWebQueryClient(data.queryState);
    let browserReads = 0;
    const options = campaignLabelOverridesQueryOptions(
      {
        getCampaignLabelOverrides: () => {
          browserReads += 1;
          return Promise.reject(new Error(CAMPAIGN_LABELS_UNAVAILABLE));
        },
      },
      { browser: true },
    );
    const observer = new QueryObserver(hydrated, options);
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.isError) {
          unsubscribe();
          resolve();
        }
      });
    });
    try {
      await settled;
      expect(browserReads).toBe(1);
      expect(observer.getCurrentResult().error?.message).toBe(CAMPAIGN_LABELS_UNAVAILABLE);
    } finally {
      hydrated.clear();
    }
  });

  test.each(['', '   ', ' leading-space'])('does not issue a malformed session lookup %j', async (rowId) => {
    const fixture = ssrFixture(rowId);
    await loadCampaignsPageData(fixture.options, 'live');
    expect(fixture.lookups).toEqual([]);
  });
});
