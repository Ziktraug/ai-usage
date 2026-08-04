import { describe, expect, test } from 'bun:test';
import {
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionPageItem,
  type SessionQueryRequest,
  type SessionQueryServerResult,
  sessionCampaignChildrenFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { createServedReportSession, type ServedRevisionDescriptor } from '../../../../served-report-session';
import { createWebQueryClient } from '../../../query/client';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import { syntheticCampaignRow, syntheticSessionRow } from './session-table.fixtures';
import {
  createSessionTableQueryOwner,
  type PreparedSessionTableQuery,
  type SessionTableQueryOwner,
  type SessionTableQueryScope,
  SessionTableRevisionExpiredError,
  sessionRowsForTableState,
  unfilteredCampaignQuery,
} from './session-table-query-owner';

const cursor = 'sq1.0000000000000000.1';
const secondCursor = 'sq1.0000000000000001.2';
const thirdCursor = 'sq1.0000000000000002.3';
const campaign = syntheticCampaignRow(1);
const root = syntheticSessionRow(1);
const child = syntheticSessionRow(2);
const nextCursorForTest = (currentCursor: string | null): string | null => {
  if (currentCursor === null) {
    return cursor;
  }
  return currentCursor === cursor ? secondCursor : null;
};

const item = (row = campaign): SessionPageItem => ({
  campaignKey: row.campaignKey ?? `campaign:${row.rowId}`,
  kind: 'campaign',
  row,
});

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

const successfulChildren = (request: SessionCampaignChildrenRequest, nextCursor: string | null = null) => {
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

const successfulChildPage = (
  request: SessionCampaignChildrenRequest,
  row: ReturnType<typeof syntheticSessionRow>,
  nextCursor: string | null,
) => {
  const result = successfulChildren(request, nextCursor);
  return {
    ...result,
    data: { ...result.data, itemCount: 3, items: [row], sessionCount: 3 },
  };
};

const scope = (query = ''): SessionTableQueryScope => {
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

const clientWith = (overrides: Partial<SessionClientAdapter>): SessionClientAdapter => {
  const unexpected = () => Promise.reject(new Error('Unexpected session client operation'));
  return {
    campaignChildren: unexpected,
    detail: unexpected,
    neighbors: unexpected,
    page: unexpected,
    vcs: unexpected,
    ...overrides,
  };
};

const createTestSessionTableServedSession = (options: {
  readonly acquire: (signal: AbortSignal) => Promise<ServedRevisionDescriptor>;
  readonly owner: SessionTableQueryOwner;
}) =>
  createServedReportSession<{ readonly scope: SessionTableQueryScope }, PreparedSessionTableQuery>({
    acquire: options.acquire,
    commit: (prepared) => {
      if (!options.owner.commit(prepared)) {
        throw new Error('The prepared session table destination was superseded before commit');
      }
    },
    destinationFingerprint: ({ scope: destinationScope }) =>
      sessionQueryFingerprint(parseSessionQueryRequest({ ...destinationScope, cursor: null, revision: 'destination' })),
    isRevisionExpired: (error) => error instanceof SessionTableRevisionExpiredError,
    load: async ({ scope: destinationScope }, descriptor, signal) =>
      await options.owner.prepare(destinationScope, descriptor.revision, signal),
  });

describe('Svelte session exact-query owner', () => {
  test('projects the authoritative page envelope campaign identity onto its presentation row', async () => {
    const row = { ...syntheticCampaignRow(9), campaignKey: 'stale-row-campaign' };
    const envelopeItem: SessionPageItem = {
      campaignKey: 'authoritative-envelope-campaign',
      kind: 'campaign',
      row,
    };
    const client = clientWith({
      page: (request) => Promise.resolve(successfulPage(request, [envelopeItem])),
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });

    owner.commit(await owner.prepare(scope(), 'revision-a'));

    expect(sessionRowsForTableState(owner.snapshot)[0]?.campaignKey).toBe('authoritative-envelope-campaign');
    owner.close();
  });

  test('atomically commits an exact page, dedupes top-level paging, and reaches campaign children', async () => {
    const pageRequests: SessionQueryRequest[] = [];
    const campaignRequests: SessionCampaignChildrenRequest[] = [];
    const client = clientWith({
      campaignChildren: (request) => {
        campaignRequests.push(request);
        return Promise.resolve(successfulChildren(request));
      },
      page: (request) => {
        pageRequests.push(request);
        return Promise.resolve(
          request.cursor === null
            ? successfulPage(request, [item()], cursor)
            : successfulPage(request, [item(syntheticCampaignRow(3))]),
        );
      },
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });

    const prepared = await owner.prepare(scope(), 'revision-a');
    expect(owner.snapshot).toBeUndefined();
    expect(owner.commit(prepared)).toBe(true);
    expect(owner.snapshot?.query.revision).toBe('revision-a');

    const [firstPaging, duplicatePaging] = await Promise.all([owner.loadMore(), owner.loadMore()]);
    expect(firstPaging).toBe(duplicatePaging);
    expect(pageRequests).toHaveLength(2);
    expect(owner.snapshot?.items).toHaveLength(2);

    await owner.loadCampaignChildren(campaign.campaignKey!);
    expect(campaignRequests).toHaveLength(1);
    expect(campaignRequests[0]?.query.revision).toBe('revision-a');
    expect(sessionRowsForTableState(owner.snapshot)[0]?.children?.map(({ rowId }) => rowId)).toEqual([child.rowId]);
    owner.close();
  });

  test('supersedes and aborts an older prepared destination before atomic commit', async () => {
    let firstAborted = false;
    const client = clientWith({
      page: (request, signal) => {
        if (request.filters.query !== 'older') {
          return Promise.resolve(successfulPage(request, [item(syntheticCampaignRow(4))]));
        }
        return new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              firstAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });

    const older = owner.prepare(scope('older'), 'revision-a');
    await Promise.resolve();
    const newer = await owner.prepare(scope('newer'), 'revision-a');

    expect((await Promise.allSettled([older]))[0]?.status).toBe('rejected');
    expect(firstAborted).toBe(true);
    expect(owner.commit(newer)).toBe(true);
    expect(owner.snapshot?.query.filters.query).toBe('newer');
    owner.close();
  });

  test('composes with the P1 ServedReportSession for one expiry retry and exact revision acceptance', async () => {
    const revisions: string[] = [];
    const client = clientWith({
      page: (request): Promise<SessionQueryServerResult<ReturnType<typeof successfulPage>['data']>> => {
        revisions.push(request.revision);
        if (request.revision === 'expired-revision') {
          return Promise.resolve({
            error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' },
            ok: false,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          });
        }
        return Promise.resolve(successfulPage(request, [item()]));
      },
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    let acquisition = 0;
    const served = createTestSessionTableServedSession({
      acquire: () => {
        acquisition += 1;
        return Promise.resolve({
          captureFingerprint: `capture-${acquisition}`,
          revision: acquisition === 1 ? 'expired-revision' : 'accepted-revision',
        });
      },
      owner,
    });

    const outcome = await served.refresh({ scope: scope() });

    expect(outcome.status).toBe('committed');
    expect(acquisition).toBe(2);
    expect(revisions).toEqual(['expired-revision', 'accepted-revision']);
    expect(owner.snapshot?.query.revision).toBe('accepted-revision');
    owner.close();
  });

  test('reacquires through the P1 lifecycle once before retrying expired top-level paging', async () => {
    const acquisitions: string[] = [];
    const requests: string[] = [];
    let revisionIndex = 0;
    const client = clientWith({
      page: (request) => {
        requests.push(`${request.revision}:${request.cursor ?? 'first'}`);
        if (request.revision === 'revision-a' && request.cursor !== null) {
          return Promise.resolve({
            error: { message: 'expired paging revision', revision: request.revision, tag: 'RevisionExpired' },
            ok: false,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          });
        }
        return Promise.resolve(
          request.cursor === null
            ? successfulPage(request, [item()], cursor)
            : successfulPage(request, [item(syntheticCampaignRow(3))]),
        );
      },
    });
    const observedItemCounts: number[] = [];
    const owner = createSessionTableQueryOwner({
      client,
      onStateChange: (state) => observedItemCounts.push(state?.items.length ?? 0),
      queryClient: createWebQueryClient(),
    });
    const served = createTestSessionTableServedSession({
      acquire: () => {
        const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
        revisionIndex += 1;
        acquisitions.push(revision);
        return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
      },
      owner,
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));

    expect((await served.refresh({ scope: scope() })).status).toBe('committed');
    await owner.loadMore();

    expect(acquisitions).toEqual(['revision-a', 'revision-b']);
    expect(requests).toEqual(['revision-a:first', `revision-a:${cursor}`, 'revision-b:first', `revision-b:${cursor}`]);
    expect(owner.snapshot?.query.revision).toBe('revision-b');
    expect(owner.snapshot?.items).toHaveLength(2);
    expect(observedItemCounts).not.toContain(0);
    owner.close();
  });

  test('surfaces repeated top-level paging expiry after one recovery without clearing rows', async () => {
    const pagingRevisions: string[] = [];
    let revisionIndex = 0;
    const client = clientWith({
      page: (request) => {
        if (request.cursor === null) {
          return Promise.resolve(successfulPage(request, [item()], cursor));
        }
        pagingRevisions.push(request.revision);
        return Promise.resolve({
          error: { message: 'expired paging revision', revision: request.revision, tag: 'RevisionExpired' },
          ok: false,
          requestFingerprint: sessionQueryFingerprint(request),
          revision: request.revision,
        });
      },
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    const served = createTestSessionTableServedSession({
      acquire: () => {
        const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
        revisionIndex += 1;
        return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
      },
      owner,
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));
    await served.refresh({ scope: scope() });

    const [result] = await Promise.allSettled([owner.loadMore()]);

    expect(result?.status).toBe('rejected');
    expect(result?.status === 'rejected' && result.reason).toBeInstanceOf(SessionTableRevisionExpiredError);
    expect(revisionIndex).toBe(2);
    expect(pagingRevisions).toEqual(['revision-a', 'revision-b']);
    expect(owner.snapshot?.query.revision).toBe('revision-b');
    expect(owner.snapshot?.items).toHaveLength(1);
    expect(owner.snapshot?.loadingMore).toBe(false);
    owner.close();
  });

  test('replays every loaded top-level page before retrying an expiry beyond page three', async () => {
    const requests: string[] = [];
    const observedItemCounts: number[] = [];
    let revisionIndex = 0;
    const rows = [
      syntheticCampaignRow(10),
      syntheticCampaignRow(11),
      syntheticCampaignRow(12),
      syntheticCampaignRow(13),
    ];
    const client = clientWith({
      page: (request) => {
        requests.push(`${request.revision}:${request.cursor ?? 'first'}`);
        if (request.revision === 'revision-a' && request.cursor === thirdCursor) {
          return Promise.resolve({
            error: { message: 'deep page expired', revision: request.revision, tag: 'RevisionExpired' },
            ok: false,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          });
        }
        if (request.cursor === null) {
          return Promise.resolve(successfulPage(request, [item(rows[0])], cursor));
        }
        if (request.cursor === cursor) {
          return Promise.resolve(successfulPage(request, [item(rows[1])], secondCursor));
        }
        if (request.cursor === secondCursor) {
          return Promise.resolve(successfulPage(request, [item(rows[2])], thirdCursor));
        }
        return Promise.resolve(successfulPage(request, [item(rows[3])]));
      },
    });
    const owner = createSessionTableQueryOwner({
      client,
      onStateChange: (next) => observedItemCounts.push(next?.items.length ?? 0),
      queryClient: createWebQueryClient(),
    });
    const served = createTestSessionTableServedSession({
      acquire: () => {
        const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
        revisionIndex += 1;
        return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
      },
      owner,
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));
    await served.refresh({ scope: scope() });
    await owner.loadMore();
    await owner.loadMore();
    const observationsBeforeExpiry = observedItemCounts.length;

    await owner.loadMore();

    expect(owner.snapshot?.items.map(({ row }) => row.rowId)).toEqual(rows.map(({ rowId }) => rowId));
    expect(owner.snapshot?.query.revision).toBe('revision-b');
    expect(observedItemCounts.slice(observationsBeforeExpiry)).not.toContain(1);
    expect(observedItemCounts.slice(observationsBeforeExpiry)).not.toContain(2);
    expect(requests.slice(-4)).toEqual([
      'revision-b:first',
      `revision-b:${cursor}`,
      `revision-b:${secondCursor}`,
      `revision-b:${thirdCursor}`,
    ]);
    owner.close();
  });

  test('replays prior campaign child pages and preserves them when the retried page expires again', async () => {
    const campaignRequests: string[] = [];
    let revisionIndex = 0;
    const children = [syntheticSessionRow(20), syntheticSessionRow(21)] as const;
    const client = clientWith({
      campaignChildren: (request) => {
        campaignRequests.push(`${request.query.revision}:${request.query.cursor ?? 'first'}`);
        if (request.query.cursor === null) {
          return Promise.resolve(successfulChildPage(request, children[0], cursor));
        }
        if (request.query.cursor === cursor) {
          return Promise.resolve(successfulChildPage(request, children[1], secondCursor));
        }
        return Promise.resolve({
          error: { message: 'deep campaign page expired', revision: request.query.revision, tag: 'RevisionExpired' },
          ok: false,
          requestFingerprint: sessionCampaignChildrenFingerprint(request),
          revision: request.query.revision,
        });
      },
      page: (request) => Promise.resolve(successfulPage(request, [item()])),
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    const served = createTestSessionTableServedSession({
      acquire: () => {
        const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
        revisionIndex += 1;
        return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
      },
      owner,
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));
    await served.refresh({ scope: scope() });
    await owner.loadCampaignChildren(campaign.campaignKey!);
    expect(owner.snapshot?.campaignChildren.get(campaign.campaignKey!)?.nextCursor).toBe(cursor);
    await owner.loadCampaignChildren(campaign.campaignKey!);

    const [result] = await Promise.allSettled([owner.loadCampaignChildren(campaign.campaignKey!)]);

    expect(result?.status).toBe('rejected');
    expect(revisionIndex).toBe(2);
    expect(owner.snapshot?.query.revision).toBe('revision-b');
    expect(owner.snapshot?.campaignChildren.get(campaign.campaignKey!)?.items.map(({ rowId }) => rowId)).toEqual(
      children.map(({ rowId }) => rowId),
    );
    expect(campaignRequests.slice(-3)).toEqual([
      'revision-b:first',
      `revision-b:${cursor}`,
      `revision-b:${secondCursor}`,
    ]);
    owner.close();
  });

  test('retries expired campaign paging once after lifecycle recovery and surfaces repeated expiry', async () => {
    const campaignRevisions: string[] = [];
    let revisionIndex = 0;
    const client = clientWith({
      campaignChildren: (request) => {
        campaignRevisions.push(request.query.revision);
        return Promise.resolve({
          error: { message: 'expired campaign revision', revision: request.query.revision, tag: 'RevisionExpired' },
          ok: false,
          requestFingerprint: sessionCampaignChildrenFingerprint(request),
          revision: request.query.revision,
        });
      },
      page: (request) => Promise.resolve(successfulPage(request, [item()])),
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    const served = createTestSessionTableServedSession({
      acquire: () => {
        const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
        revisionIndex += 1;
        return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
      },
      owner,
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));
    await served.refresh({ scope: scope() });

    const [result] = await Promise.allSettled([owner.loadCampaignChildren(campaign.campaignKey!)]);

    expect(result?.status).toBe('rejected');
    expect(result?.status === 'rejected' && result.reason).toBeInstanceOf(SessionTableRevisionExpiredError);
    expect(revisionIndex).toBe(2);
    expect(campaignRevisions).toEqual(['revision-a', 'revision-b']);
    expect(owner.snapshot?.query.revision).toBe('revision-b');
    expect(owner.snapshot?.items).toHaveLength(1);
    expect(owner.snapshot?.campaignChildren.get(campaign.campaignKey!)).toBeUndefined();
    owner.close();
  });

  test('derives an all-campaign request without changing revision, sort, page size, or cursor', () => {
    const filtered = parseSessionQueryRequest({
      ...scope('needle'),
      cursor,
      filters: {
        fields: { campaign: campaign.campaignKey!, provider: 'Synthetic provider' },
        harness: ['codex'],
        localTimeCell: { hour: 12, weekday: 1 },
        machine: ['synthetic-machine'],
        origin: ['human'],
        query: 'needle',
      },
      range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
      revision: 'revision-a',
    });

    expect(unfilteredCampaignQuery(filtered, secondCursor)).toEqual({
      cursor: secondCursor,
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      pageSize: filtered.pageSize,
      range: { from: null, to: null },
      revision: filtered.revision,
      sort: filtered.sort,
    });
  });

  test('loads one filtered and one unfiltered page through the sole owner without changing table semantics', async () => {
    const hiddenChild = syntheticSessionRow(3);
    const requests: SessionCampaignChildrenRequest[] = [];
    const client = clientWith({
      campaignChildren: (request) => {
        requests.push(request);
        const unfiltered = request.query.filters.query === '';
        const data = {
          campaignKey: request.campaignKey,
          itemCount: 1,
          items: [unfiltered ? hiddenChild : child],
          nextCursor: null,
          requestFingerprint: sessionCampaignChildrenFingerprint(request),
          revision: request.query.revision,
          root,
          sessionCount: 1,
        };
        return Promise.resolve({
          data,
          ok: true as const,
          requestFingerprint: data.requestFingerprint,
          revision: data.revision,
        });
      },
      page: (request) => Promise.resolve(successfulPage(request, [item()])),
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    owner.commit(await owner.prepare(scope('needle'), 'revision-a'));

    const [first, duplicate] = await Promise.all([
      owner.loadCampaignSessions(campaign.campaignKey!),
      owner.loadCampaignSessions(campaign.campaignKey!),
    ]);

    expect(first).toBe(duplicate);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query.filters.query).toBe('needle');
    expect(requests[1]?.query.filters).toEqual({ fields: {}, harness: [], machine: [], origin: [], query: '' });
    expect(owner.snapshot?.query.filters.query).toBe('needle');
    expect(owner.snapshot?.campaignChildren.get(campaign.campaignKey!)?.items).toEqual([child]);
    expect(owner.snapshot?.campaignSessions.get(campaign.campaignKey!)).toMatchObject({
      items: [hiddenChild],
      nextCursor: null,
      root,
      totalCount: 1,
    });
    expect(sessionRowsForTableState(owner.snapshot)[0]?.children).toEqual([child]);
    expect(owner.snapshot?.items[0]?.row).toBe(campaign);
    owner.close();
  });

  test('replays loaded filtered and unfiltered campaign depth before retrying one expired all-session page', async () => {
    const allChildren = [syntheticSessionRow(30), syntheticSessionRow(31)] as const;
    const requests: string[] = [];
    let revisionIndex = 0;
    const client = clientWith({
      campaignChildren: (request) => {
        const unfiltered = request.query.filters.query === '';
        requests.push(
          `${request.query.revision}:${unfiltered ? 'all' : 'filtered'}:${request.query.cursor ?? 'first'}`,
        );
        if (!unfiltered) {
          const result = successfulChildren(request);
          return Promise.resolve({
            ...result,
            data: { ...result.data, items: [child], itemCount: 1, sessionCount: 1 },
          });
        }
        if (request.query.revision === 'revision-a' && request.query.cursor === cursor) {
          return Promise.resolve({
            error: {
              message: 'expired all-session page',
              revision: request.query.revision,
              tag: 'RevisionExpired' as const,
            },
            ok: false as const,
            requestFingerprint: sessionCampaignChildrenFingerprint(request),
            revision: request.query.revision,
          });
        }
        return Promise.resolve(
          successfulChildPage(
            request,
            request.query.cursor === null ? allChildren[0] : allChildren[1],
            request.query.cursor === null ? cursor : null,
          ),
        );
      },
      page: (request) => Promise.resolve(successfulPage(request, [item()])),
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    const served = createTestSessionTableServedSession({
      acquire: () => {
        const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
        revisionIndex += 1;
        return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
      },
      owner,
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));
    await served.refresh({ scope: scope('needle') });
    await owner.loadCampaignSessions(campaign.campaignKey!);

    await owner.loadCampaignSessions(campaign.campaignKey!);

    expect(revisionIndex).toBe(2);
    expect(owner.snapshot?.query.revision).toBe('revision-b');
    expect(owner.snapshot?.campaignSessions.get(campaign.campaignKey!)?.items).toEqual(allChildren);
    expect(owner.snapshot?.campaignChildren.get(campaign.campaignKey!)?.items).toEqual([child]);
    expect(requests.slice(-3)).toEqual([
      'revision-b:filtered:first',
      'revision-b:all:first',
      `revision-b:all:${cursor}`,
    ]);
    owner.close();
  });
  test('keeps pair A visible until revision B replay completes, then publishes Sessions before Overview', async () => {
    const replayStarted = Promise.withResolvers<void>();
    const replayPage = Promise.withResolvers<ReturnType<typeof successfulPage>>();
    const visibleEvents: string[] = [];
    let visibleOverview = 'revision-a';
    let visibleSessions = 'revision-a';
    const client = clientWith({
      page: (request) => {
        if (request.revision === 'revision-a' && request.cursor === secondCursor) {
          return Promise.resolve({
            error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' as const },
            ok: false as const,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          });
        }
        if (request.revision === 'revision-b' && request.cursor === cursor) {
          replayStarted.resolve();
          return replayPage.promise;
        }
        const nextCursor = nextCursorForTest(request.cursor);
        return Promise.resolve(
          successfulPage(request, [item(syntheticCampaignRow(request.cursor === null ? 1 : 3))], nextCursor),
        );
      },
    });
    const owner = createSessionTableQueryOwner({
      client,
      onStateChange: (state) => {
        visibleSessions = state?.query.revision ?? 'missing';
        visibleEvents.push(`sessions:${visibleSessions}`);
      },
      queryClient: createWebQueryClient(),
    });
    owner.commit(await owner.prepare(scope(), 'revision-a'));
    await owner.loadMore();
    owner.setRevisionRefresh(async (nextScope) => {
      const prepared = await owner.prepare(nextScope, 'revision-b');
      const commitOutcome = owner.commitWithVisible(prepared, () => {
        expect(visibleSessions).toBe('revision-b');
        visibleOverview = 'revision-b';
        visibleEvents.push('overview:revision-b');
      });
      expect(commitOutcome).toBe('staged');
      return { descriptor: { captureFingerprint: 'capture-b', revision: 'revision-b' }, status: 'committed' };
    });

    const recovery = owner.loadMore();
    await replayStarted.promise;
    expect([visibleOverview, visibleSessions]).toEqual(['revision-a', 'revision-a']);

    const replayedState = owner.snapshot;
    if (!replayedState) {
      throw new Error('Expected staged revision state');
    }
    const replayRequest = parseSessionQueryRequest({ ...replayedState.query, cursor });
    replayPage.resolve(successfulPage(replayRequest, [item(syntheticCampaignRow(4))], secondCursor));
    await recovery;

    expect([visibleOverview, visibleSessions]).toEqual(['revision-b', 'revision-b']);
    expect(visibleEvents.indexOf('sessions:revision-b')).toBeLessThan(visibleEvents.indexOf('overview:revision-b'));
    owner.close();
  });

  test('clears a failed staged pair and reconstructs the same revision when recovery retries', async () => {
    let combinedLoads = 0;
    let replayAttempts = 0;
    let visibleOverview = 'revision-a';
    let visibleSessions = 'revision-a';
    const client = clientWith({
      page: (request) => {
        if (request.revision === 'revision-a' && request.cursor === secondCursor) {
          return Promise.resolve({
            error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' as const },
            ok: false as const,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          });
        }
        if (request.revision === 'revision-b' && request.cursor === cursor) {
          replayAttempts += 1;
          if (replayAttempts === 1) {
            return Promise.reject(new Error('replay failed'));
          }
        }
        const nextCursor = nextCursorForTest(request.cursor);
        return Promise.resolve(
          successfulPage(request, [item(syntheticCampaignRow(request.cursor === null ? 1 : 5))], nextCursor),
        );
      },
    });
    const owner = createSessionTableQueryOwner({
      client,
      onStateChange: (state) => {
        visibleSessions = state?.query.revision ?? 'missing';
      },
      queryClient: createWebQueryClient(),
    });
    owner.commit(await owner.prepare(scope(), 'revision-a'));
    await owner.loadMore();
    const served = createServedReportSession<{ readonly scope: SessionTableQueryScope }, PreparedSessionTableQuery>({
      acquire: () => Promise.resolve({ captureFingerprint: 'capture-b', revision: 'revision-b' }),
      commit: (prepared, _descriptor, _destination, finalizeVisibleCommit) => {
        const outcome = owner.commitWithVisible(prepared, () => {
          expect(visibleSessions).toBe('revision-b');
          visibleOverview = 'revision-b';
          finalizeVisibleCommit();
        });
        return outcome === 'published';
      },
      destinationFingerprint: ({ scope: destinationScope }) => JSON.stringify(destinationScope),
      isRevisionExpired: () => false,
      load: async ({ scope: destinationScope }, descriptor, signal) => {
        combinedLoads += 1;
        return await owner.prepare(destinationScope, descriptor.revision, signal);
      },
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));

    await expect(owner.loadMore()).rejects.toThrow('replay failed');
    expect([visibleOverview, visibleSessions]).toEqual(['revision-a', 'revision-a']);

    await owner.loadMore();
    expect(combinedLoads).toBe(2);
    expect(replayAttempts).toBe(2);
    expect([visibleOverview, visibleSessions]).toEqual(['revision-b', 'revision-b']);
    expect((await served.refresh({ scope: scope() })).status).toBe('no-change');
    expect(combinedLoads).toBe(2);
    owner.close();
  });

  test('restores the previous non-loading state when an external failed refresh abandons a blocked recovery', async () => {
    const replayGate = Promise.withResolvers<void>();
    const replayStarted = Promise.withResolvers<void>();
    let revision = 'revision-a';
    const client = clientWith({
      page: async (request) => {
        if (request.revision === 'revision-a' && request.cursor === secondCursor) {
          return {
            error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' as const },
            ok: false as const,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          };
        }
        if (request.revision === 'revision-b' && request.cursor === cursor) {
          replayStarted.resolve();
          await replayGate.promise;
        }
        if (request.revision === 'revision-c') {
          throw new Error('external refresh failed');
        }
        return successfulPage(request, [item()], nextCursorForTest(request.cursor));
      },
    });
    const owner = createSessionTableQueryOwner({ client, queryClient: createWebQueryClient() });
    const served = createServedReportSession<{ readonly scope: SessionTableQueryScope }, PreparedSessionTableQuery>({
      acquire: () => Promise.resolve({ captureFingerprint: `capture-${revision}`, revision }),
      commit: (prepared, _descriptor, _destination, finalizeVisibleCommit) => {
        const outcome = owner.commitWithVisible(prepared, finalizeVisibleCommit);
        return outcome === 'published';
      },
      destinationFingerprint: ({ scope: destinationScope }) => JSON.stringify(destinationScope),
      isRevisionExpired: () => false,
      load: async ({ scope: destinationScope }, descriptor, signal) =>
        await owner.prepare(destinationScope, descriptor.revision, signal),
    });
    owner.setRevisionRefresh(async (nextScope) => await served.refresh({ scope: nextScope }));
    await served.refresh({ scope: scope('preserved') });
    await owner.loadMore();

    revision = 'revision-b';
    const lateRecovery = owner.loadMore();
    await replayStarted.promise;
    revision = 'revision-c';
    const externalOutcome = await served.refresh({ scope: scope('external') });

    expect(externalOutcome.status).toBe('failed-preserving-previous');
    expect(owner.snapshot?.query.revision).toBe('revision-a');
    expect(owner.snapshot?.query.filters.query).toBe('preserved');
    expect(owner.snapshot?.loadingMore).toBe(false);

    replayGate.resolve();
    await lateRecovery;
    expect(owner.snapshot?.query.revision).toBe('revision-a');
    expect(owner.snapshot?.loadingMore).toBe(false);
    owner.close();
  });
});
