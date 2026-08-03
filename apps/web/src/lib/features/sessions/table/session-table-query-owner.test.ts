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
import { createServedReportSession } from '../../../../served-report-session';
import { createWebQueryClient } from '../../../query/client';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import { syntheticCampaignRow, syntheticSessionRow } from './session-table.fixtures';
import {
  createSessionTableQueryOwner,
  createSessionTableServedAdapter,
  type SessionTableQueryScope,
  SessionTableRevisionExpiredError,
  sessionRowsForTableState,
} from './session-table-query-owner';

const cursor = 'sq1.0000000000000000.1';
const campaign = syntheticCampaignRow(1);
const child = syntheticSessionRow(2);

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
    sessionCount: 1,
  };
  return { data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision } as const;
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
    const served = createServedReportSession(
      createSessionTableServedAdapter({
        acquire: () => {
          acquisition += 1;
          return Promise.resolve({
            captureFingerprint: `capture-${acquisition}`,
            revision: acquisition === 1 ? 'expired-revision' : 'accepted-revision',
          });
        },
        owner,
      }),
    );

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
    const served = createServedReportSession(
      createSessionTableServedAdapter({
        acquire: () => {
          const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
          revisionIndex += 1;
          acquisitions.push(revision);
          return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
        },
        owner,
      }),
    );
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
    const served = createServedReportSession(
      createSessionTableServedAdapter({
        acquire: () => {
          const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
          revisionIndex += 1;
          return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
        },
        owner,
      }),
    );
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
    const served = createServedReportSession(
      createSessionTableServedAdapter({
        acquire: () => {
          const revision = revisionIndex === 0 ? 'revision-a' : 'revision-b';
          revisionIndex += 1;
          return Promise.resolve({ captureFingerprint: `capture-${revision}`, revision });
        },
        owner,
      }),
    );
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
});
