import { describe, expect, test } from 'bun:test';
import {
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionPageItem,
  type SessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { syntheticCampaignRow, syntheticSessionRow } from '../../features/sessions/table/session-table.fixtures';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { createWebQueryClient } from '../client';
import {
  ensureSessionWindow,
  increaseSessionWindowDepth,
  initialSessionWindowIntent,
  projectSessionDestinationRows,
  resetSessionWindowProjectionStats,
  type SessionQueryScope,
  SessionRevisionExpiredError,
  type SessionWindowQueryData,
  sessionWindowProjectionStats,
  sessionWindowSatisfiesIntent,
  sessionWindowView,
} from './session-window';

const cursor = 'sq1.0000000000000000.1';
const campaign = syntheticCampaignRow(1);
const secondCampaign = syntheticCampaignRow(2);
const root = syntheticSessionRow(1);
const child = syntheticSessionRow(2);

const pageItem = (row = campaign): SessionPageItem => ({
  campaignKey: row.campaignKey ?? `campaign:${row.rowId}`,
  kind: 'campaign',
  row,
});

const scope = (query = ''): SessionQueryScope => {
  const request = parseSessionQueryRequest({
    cursor: null,
    filters: { fields: {}, harness: [], machine: [], origin: [], query },
    pageSize: 100,
    range: { from: null, to: null },
    revision: 'scope-placeholder',
    sort: [{ desc: true, id: 'date' }],
  });
  const { cursor: _cursor, revision: _revision, ...queryScope } = request;
  return queryScope;
};

const successfulPage = (request: SessionQueryRequest, items: SessionPageItem[], nextCursor: string | null = null) => {
  const data = {
    itemCount: items.length + (nextCursor ? 1 : 0),
    items,
    nextCursor,
    requestFingerprint: sessionQueryFingerprint(request),
    revision: request.revision,
    sessionCount: items.length + (nextCursor ? 1 : 0),
  };
  return { data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision } as const;
};

const successfulCampaignPage = (request: SessionCampaignChildrenRequest, nextCursor: string | null = null) => {
  const data = {
    campaignKey: request.campaignKey,
    itemCount: 1,
    items: [child],
    nextCursor,
    requestFingerprint: sessionCampaignChildrenFingerprint(request),
    revision: request.query.revision,
    root,
    sessionCount: 1,
  };
  return { data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision } as const;
};

const clientWith = (overrides: Partial<SessionClientAdapter>): SessionClientAdapter => {
  const unexpected = () => Promise.reject(new Error('Unexpected Session operation'));
  return {
    campaignChildren: unexpected,
    detail: unexpected,
    neighbors: unexpected,
    page: unexpected,
    vcs: unexpected,
    ...overrides,
  };
};

describe('Session infinite Query window', () => {
  test('fetches only the newly requested top-level page and deduplicates concurrent depth growth', async () => {
    const queryClient = createWebQueryClient();
    const requests: (string | null)[] = [];
    const client = clientWith({
      page: (request) => {
        requests.push(request.cursor);
        return Promise.resolve(
          request.cursor === null
            ? successfulPage(request, [pageItem()], cursor)
            : successfulPage(request, [pageItem(secondCampaign)]),
        );
      },
    });
    const firstIntent = initialSessionWindowIntent();
    const secondIntent = increaseSessionWindowDepth(firstIntent, 'top-level');
    const initial = await ensureSessionWindow({
      client,
      intent: firstIntent,
      queryClient,
      revision: 'revision-a',
      scope: scope(),
      signal: new AbortController().signal,
    });

    const [first, duplicate] = await Promise.all([
      ensureSessionWindow({
        client,
        intent: secondIntent,
        queryClient,
        revision: 'revision-a',
        scope: scope(),
        signal: new AbortController().signal,
      }),
      ensureSessionWindow({
        client,
        intent: secondIntent,
        queryClient,
        revision: 'revision-a',
        scope: scope(),
        signal: new AbortController().signal,
      }),
    ]);

    expect(initial.topLevel.pages).toHaveLength(1);
    expect(first.topLevel.pages).toHaveLength(2);
    expect(sessionWindowSatisfiesIntent(initial, firstIntent)).toBe(true);
    expect(sessionWindowSatisfiesIntent(initial, secondIntent)).toBe(false);
    expect(sessionWindowSatisfiesIntent(first, secondIntent)).toBe(true);
    expect(duplicate.topLevel.pages).toHaveLength(2);
    expect(requests).toEqual([null, cursor]);
    expect(sessionWindowView(first, secondIntent, false).items).toHaveLength(2);
    queryClient.clear();
  });

  test('keeps filtered expansion and unfiltered campaign sessions in separate exact infinite keys', async () => {
    const queryClient = createWebQueryClient();
    const requests: SessionCampaignChildrenRequest[] = [];
    const client = clientWith({
      campaignChildren: (request) => {
        requests.push(request);
        return Promise.resolve(successfulCampaignPage(request));
      },
      page: (request) => Promise.resolve(successfulPage(request, [pageItem()])),
    });
    const campaignKey = campaign.campaignKey ?? '';
    const withChildren = increaseSessionWindowDepth(initialSessionWindowIntent(), 'campaign-children', campaignKey);
    const intent = increaseSessionWindowDepth(withChildren, 'campaign-sessions', campaignKey);

    const data = await ensureSessionWindow({
      client,
      intent,
      queryClient,
      revision: 'revision-campaign',
      scope: scope('needle'),
      signal: new AbortController().signal,
    });
    const view = sessionWindowView(data, intent, false);

    expect(requests).toHaveLength(2);
    expect(requests.map(({ query }) => query.filters.query).sort()).toEqual(['', 'needle']);
    expect(view.campaignChildren.get(campaignKey)?.items.map(({ rowId }) => rowId)).toEqual([child.rowId]);
    expect(view.campaignSessions.get(campaignKey)?.root?.rowId).toBe(root.rowId);
    queryClient.clear();
  });

  test('uses revision-separated keys and replays the requested depth for a new exact revision', async () => {
    const queryClient = createWebQueryClient();
    const requests: string[] = [];
    const client = clientWith({
      page: (request) => {
        requests.push(`${request.revision}:${request.cursor ?? 'first'}`);
        return Promise.resolve(
          request.cursor === null
            ? successfulPage(request, [pageItem()], cursor)
            : successfulPage(request, [pageItem(secondCampaign)]),
        );
      },
    });
    const intent = increaseSessionWindowDepth(initialSessionWindowIntent(), 'top-level');

    for (const revision of ['revision-a', 'revision-b']) {
      const data = await ensureSessionWindow({
        client,
        intent,
        queryClient,
        revision,
        scope: scope(),
        signal: new AbortController().signal,
      });
      expect(data.topLevel.pages).toHaveLength(2);
      expect(data.query.revision).toBe(revision);
    }

    expect(requests).toEqual(['revision-a:first', `revision-a:${cursor}`, 'revision-b:first', `revision-b:${cursor}`]);
    queryClient.clear();
  });

  test('append-aware projection visits O(new page) and keeps prior item identity', () => {
    resetSessionWindowProjectionStats();
    const firstPage = successfulPage(
      parseSessionQueryRequest({ ...scope(), cursor: null, revision: 'revision-append' }),
      [pageItem(campaign)],
      cursor,
    ).data;
    const secondPage = successfulPage(parseSessionQueryRequest({ ...scope(), cursor, revision: 'revision-append' }), [
      pageItem(secondCampaign),
    ]).data;
    const query = parseSessionQueryRequest({ ...scope(), cursor: null, revision: 'revision-append' });
    const firstData: SessionWindowQueryData = {
      campaignChildren: [],
      campaignSessions: [],
      query,
      topLevel: { pageParams: [null], pages: [firstPage] },
    };
    const firstView = sessionWindowView(firstData, initialSessionWindowIntent(), false);
    const afterFirst = sessionWindowProjectionStats().topLevelRowVisits;
    expect(afterFirst).toBe(1);
    expect(firstView.items).toHaveLength(1);

    const appendedData: SessionWindowQueryData = {
      campaignChildren: [],
      campaignSessions: [],
      query,
      topLevel: { pageParams: [null, cursor], pages: [firstPage, secondPage] },
    };
    const appendedView = sessionWindowView(appendedData, initialSessionWindowIntent(), false);
    expect(sessionWindowProjectionStats().topLevelRowVisits - afterFirst).toBe(1);
    expect(appendedView.items).toHaveLength(2);
    expect(appendedView.items[0]).toBe(firstView.items[0]);

    const duplicateView = sessionWindowView(appendedData, initialSessionWindowIntent(), false);
    expect(sessionWindowProjectionStats().topLevelRowVisits - afterFirst).toBe(1);
    expect(duplicateView.items).toBe(appendedView.items);

    const resortedQuery = parseSessionQueryRequest({
      ...scope(),
      cursor: null,
      revision: 'revision-append',
      sort: [{ desc: false, id: 'date' }],
    });
    const resortedPage = { ...firstPage, requestFingerprint: sessionQueryFingerprint(resortedQuery) };
    const resortedData: SessionWindowQueryData = {
      campaignChildren: [],
      campaignSessions: [],
      query: resortedQuery,
      topLevel: { pageParams: [null], pages: [resortedPage] },
    };
    const beforeResort = sessionWindowProjectionStats().topLevelRowVisits;
    sessionWindowView(resortedData, initialSessionWindowIntent(), false);
    expect(sessionWindowProjectionStats().topLevelRowVisits - beforeResort).toBe(1);

    resetSessionWindowProjectionStats();
    const destinationFirst = projectSessionDestinationRows(firstView);
    expect(sessionWindowProjectionStats().destinationRowVisits).toBe(1);
    expect(destinationFirst[0]).toBe(firstView.items[0]?.row);
    const destinationAppended = projectSessionDestinationRows(appendedView);
    expect(sessionWindowProjectionStats().destinationRowVisits).toBe(2);
    expect(destinationAppended[0]).toBe(destinationFirst[0]);
    expect(destinationAppended).toHaveLength(2);
  });

  test('surfaces typed expiry and propagates outer cancellation to the active page query', async () => {
    const expiredClient = clientWith({
      page: (request) =>
        Promise.resolve({
          error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' as const },
          ok: false as const,
          requestFingerprint: sessionQueryFingerprint(request),
          revision: request.revision,
        }),
    });
    const expired = ensureSessionWindow({
      client: expiredClient,
      intent: initialSessionWindowIntent(),
      queryClient: createWebQueryClient(),
      revision: 'revision-expired',
      scope: scope(),
      signal: new AbortController().signal,
    });
    expect((await Promise.allSettled([expired]))[0]).toMatchObject({
      reason: expect.any(SessionRevisionExpiredError),
      status: 'rejected',
    });

    let aborted = false;
    const controller = new AbortController();
    const pending = ensureSessionWindow({
      client: clientWith({
        page: (_request, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
      intent: initialSessionWindowIntent(),
      queryClient: createWebQueryClient(),
      revision: 'revision-cancelled',
      scope: scope(),
      signal: controller.signal,
    });
    controller.abort();
    expect((await Promise.allSettled([pending]))[0]?.status).toBe('rejected');
    expect(aborted).toBe(true);
  });
});
