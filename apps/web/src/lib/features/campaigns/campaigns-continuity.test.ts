import { describe, expect, test } from 'bun:test';
import {
  buildCampaignChronology,
  type SessionCampaignChildrenRequest,
  type SessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { InfiniteQueryObserver } from '@tanstack/svelte-query';
import { dashboardSearchDefaultsFor, validateDashboardSearch } from '../../../dashboard-search';
import { createWebQueryClient } from '../../query/client';
import { pruneCampaignExplorations } from '../../query/options/campaigns';
import { initialSessionWindowIntent } from '../../query/options/session-window';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { syntheticCampaignRow, syntheticSessionRow } from '../sessions/table/session-table.fixtures';
import {
  type CampaignExplorationData,
  campaignMatchingMembersOptions,
  campaignMembersOptions,
  campaignsExplorationOptions,
  campaignsListOptions,
  campaignsRequest,
} from './campaigns-query';

const requestFor = (revision: string) =>
  campaignsRequest(
    validateDashboardSearch({ range: 'all' }, dashboardSearchDefaultsFor('date')),
    '2026-10-04T12:00:00.000Z',
    revision,
  );
const cursor = (offset: number) => `sq1.0000000000000000.${offset}`;
const offsetFor = (value: string | null) => (value === null ? 0 : Number(value.split('.').at(-1)));
const root = syntheticCampaignRow(1);
const campaignKey = root.campaignKey ?? '';
const page = (request: SessionQueryRequest, count = 125) => {
  const offset = offsetFor(request.cursor);
  const items = Array.from({ length: Math.min(request.pageSize, Math.max(0, count - offset)) }, (_, index) => {
    const row = syntheticCampaignRow(offset + index + 1);
    return {
      campaignKey: row.campaignKey ?? '',
      chronology: buildCampaignChronology([row]),
      kind: 'campaign' as const,
      row,
    };
  });
  const data = {
    itemCount: count,
    items,
    nextCursor: offset + items.length < count ? cursor(offset + items.length) : null,
    requestFingerprint: sessionQueryFingerprint(request),
    revision: request.revision,
    sessionCount: count,
  };
  return { data, ok: true as const, requestFingerprint: data.requestFingerprint, revision: data.revision };
};
const members = (request: SessionCampaignChildrenRequest, count = 235) => {
  const offset = offsetFor(request.query.cursor);
  const items = Array.from({ length: Math.min(request.query.pageSize, Math.max(0, count - offset)) }, (_, index) =>
    syntheticSessionRow(offset + index + 1000),
  );
  const data = {
    campaignKey: request.campaignKey,
    itemCount: count,
    items,
    nextCursor: offset + items.length < count ? cursor(offset + items.length) : null,
    requestFingerprint: sessionCampaignChildrenFingerprint(request),
    revision: request.query.revision,
    root,
    sessionCount: count + 1,
  };
  return { data, ok: true as const, requestFingerprint: data.requestFingerprint, revision: data.revision };
};
const clientWith = (overrides: Partial<SessionClientAdapter> = {}): SessionClientAdapter => {
  const unexpected = () => Promise.reject(new Error('Unexpected request'));
  return {
    campaignChildren: async (request) => members(request),
    detail: unexpected,
    lookup: unexpected,
    neighbors: unexpected,
    page: async (request) => page(request),
    vcs: unexpected,
    ...overrides,
  };
};

describe('Campaign acquisition continuity', () => {
  test('restores both explored page depths in the next revision', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith();
    const list = new InfiniteQueryObserver(queryClient, campaignsListOptions(client, requestFor('r1')));
    const descendants = new InfiniteQueryObserver(queryClient, campaignMembersOptions(client, 'r1', campaignKey));
    try {
      await list.refetch();
      await list.fetchNextPage();
      await descendants.refetch();
      await descendants.fetchNextPage();
      expect(list.getCurrentResult().data?.pages).toHaveLength(2);
      expect(descendants.getCurrentResult().data?.pages.flatMap((entry) => entry.items)).toHaveLength(200);
      const next = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          client,
          intent: { ...initialSessionWindowIntent(), campaignSessionsDepth: { [campaignKey]: 2 }, topLevelDepth: 2 },
          queryClient,
          request: requestFor('r2'),
        }),
      );
      expect(next.list.pages).toHaveLength(2);
      expect(next.members[0]?.data.pages).toHaveLength(2);
      expect(next.list.pages.every((entry) => entry.revision === 'r2')).toBe(true);
      expect(next.members[0]?.data.pages.every((entry) => entry.revision === 'r2')).toBe(true);
    } finally {
      list.destroy();
      descendants.destroy();
      queryClient.clear();
    }
  });

  test('rejects a repeated cursor before appending the invalid page', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith({
      page: (request) => {
        const result = page(request);
        return Promise.resolve(
          request.cursor === null ? result : { ...result, data: { ...result.data, nextCursor: request.cursor } },
        );
      },
    });
    const observer = new InfiniteQueryObserver(queryClient, campaignsListOptions(client, requestFor('r1')));
    try {
      await observer.refetch();
      await expect(observer.fetchNextPage({ throwOnError: true })).rejects.toThrow('progress');
      expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
    } finally {
      observer.destroy();
      queryClient.clear();
    }
  });
});

describe('Campaign restoration boundaries', () => {
  test('publishes the presentation range with the exact exploration context', async () => {
    const queryClient = createWebQueryClient();
    let listCalls = 0;
    const client = clientWith({
      page: (request) => {
        listCalls += 1;
        return Promise.resolve(page(request));
      },
    });
    const request = requestFor('r1');
    const options = {
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request,
    };
    const firstRange = { from: '2026-10-03', to: '2026-10-03' };
    const nextRange = { from: '2026-10-04', to: '2026-10-04' };
    try {
      const firstOptions = campaignsExplorationOptions({ ...options, timelineRange: firstRange });
      const nextOptions = campaignsExplorationOptions({ ...options, timelineRange: nextRange });
      expect(nextOptions.queryKey).not.toEqual(firstOptions.queryKey);
      const first = await queryClient.fetchQuery(firstOptions);
      const next = await queryClient.fetchQuery(nextOptions);
      expect(first.timelineRange).toEqual(firstRange);
      expect(next.timelineRange).toEqual(nextRange);
      expect(queryClient.getQueryData<CampaignExplorationData>(firstOptions.queryKey)?.timelineRange).toEqual(
        firstRange,
      );
      expect(listCalls).toBe(1);
    } finally {
      queryClient.clear();
    }
  });

  test('defaults the presentation range to the acquired request for existing callers', async () => {
    const queryClient = createWebQueryClient();
    const request = requestFor('r1');
    try {
      const data = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          client: clientWith(),
          intent: initialSessionWindowIntent(),
          queryClient,
          request,
        }),
      );
      expect(data.timelineRange).toEqual(request.range);
    } finally {
      queryClient.clear();
    }
  });

  test('continues a deep active exploration after inactive infinite entries are collected', async () => {
    const queryClient = createWebQueryClient();
    let listCalls = 0;
    let memberCalls = 0;
    const client = clientWith({
      page: (request) => {
        listCalls += 1;
        return Promise.resolve(page(request, 100_000));
      },
      campaignChildren: (request) => {
        memberCalls += 1;
        return Promise.resolve(members(request));
      },
    });
    const request = requestFor('r1');
    try {
      for (let depth = 1; depth <= 33; depth += 1) {
        const options = campaignsExplorationOptions({
          client,
          intent: {
            ...initialSessionWindowIntent(),
            topLevelDepth: depth,
            campaignSessionsDepth: { [campaignKey]: 2 },
          },
          queryClient,
          request,
        });
        await queryClient.fetchQuery(options);
        pruneCampaignExplorations(queryClient, options.queryKey);
      }
      expect(listCalls).toBe(33);
      expect(memberCalls).toBe(2);
      queryClient.removeQueries({ exact: true, queryKey: campaignsListOptions(client, request).queryKey });
      queryClient.removeQueries({ exact: true, queryKey: campaignMembersOptions(client, 'r1', campaignKey).queryKey });
      const continued = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          client,
          intent: { ...initialSessionWindowIntent(), topLevelDepth: 34, campaignSessionsDepth: { [campaignKey]: 3 } },
          queryClient,
          request,
        }),
      );
      expect(continued.list.pages).toHaveLength(34);
      expect(continued.members[0]?.data.pages).toHaveLength(3);
      expect(listCalls).toBe(34);
      expect(memberCalls).toBe(3);
    } finally {
      queryClient.clear();
    }
  });
  test('restores filtered matching-result depth and its displaced anchor before publication', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith();
    const request = { ...requestFor('r2'), filters: { ...requestFor('r2').filters, query: 'needle' } };
    try {
      const data = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          client,
          intent: initialSessionWindowIntent(),
          queryClient,
          request,
          matching: { campaignKey, depth: 2, rowIds: [syntheticSessionRow(1220).rowId] },
        }),
      );
      const matching = queryClient.getQueryData<{ pages: readonly { items: readonly { rowId: string }[] }[] }>(
        campaignMatchingMembersOptions(client, request, campaignKey).queryKey,
      );
      expect(matching?.pages).toHaveLength(3);
      expect(
        matching?.pages.flatMap((entry) => entry.items).some((row) => row.rowId === syntheticSessionRow(1220).rowId),
      ).toBe(true);
      expect(data.missingAnchors).toEqual([]);
      expect(data.members).toHaveLength(0);
    } finally {
      queryClient.clear();
    }
  });
  test('bounds a deep fresh revision replay while allowing subsequent cached exploration', async () => {
    const queryClient = createWebQueryClient();
    let calls = 0;
    const client = clientWith({
      page: (request) => {
        calls += 1;
        return Promise.resolve(page(request, 100_000));
      },
    });
    try {
      await expect(
        queryClient.fetchQuery(
          campaignsExplorationOptions({
            client,
            intent: { ...initialSessionWindowIntent(), topLevelDepth: 5000 },
            queryClient,
            request: requestFor('r2'),
          }),
        ),
      ).rejects.toThrow('bounded refresh window');
      expect(calls).toBe(32);
      const continued = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          client,
          intent: { ...initialSessionWindowIntent(), topLevelDepth: 33 },
          queryClient,
          request: requestFor('r2'),
        }),
      );
      expect(continued.list.pages).toHaveLength(33);
      expect(calls).toBe(33);
    } finally {
      queryClient.clear();
    }
  });

  test('prunes obsolete composites without evicting the explored exact pages', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith();
    const first = campaignsExplorationOptions({
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request: requestFor('r1'),
    });
    const next = campaignsExplorationOptions({
      client,
      intent: { ...initialSessionWindowIntent(), topLevelDepth: 2 },
      queryClient,
      request: requestFor('r1'),
    });
    try {
      await queryClient.fetchQuery(first);
      const data = await queryClient.fetchQuery(next);
      pruneCampaignExplorations(queryClient, next.queryKey);
      expect(queryClient.getQueryData<CampaignExplorationData>(first.queryKey)).toBeUndefined();
      expect(queryClient.getQueryData<CampaignExplorationData>(next.queryKey)).toBe(data);
      expect(queryClient.getQueryData<typeof data.list>(campaignsListOptions(client, requestFor('r1')).queryKey)).toBe(
        data.list,
      );
      expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
    } finally {
      queryClient.clear();
    }
  });
  test('restores stable campaign and member identities displaced beyond the old depth', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith();
    try {
      const data = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          anchors: {
            campaignKeys: ['synthetic-campaign-101'],
            memberRowIds: { [campaignKey]: [syntheticSessionRow(1220).rowId] },
          },
          client,
          intent: { ...initialSessionWindowIntent(), campaignSessionsDepth: { [campaignKey]: 1 } },
          queryClient,
          request: requestFor('r2'),
        }),
      );
      expect(data.list.pages).toHaveLength(3);
      expect(data.members[0]?.data.pages).toHaveLength(3);
      expect(data.missingAnchors).toEqual([]);
    } finally {
      queryClient.clear();
    }
  });

  test('caps an unsuccessful restoration at four additional pages and keeps the old composite', async () => {
    const queryClient = createWebQueryClient();
    const requests: SessionQueryRequest[] = [];
    const client = clientWith({
      page: (request) => {
        requests.push(request);
        return Promise.resolve(page(request, 10_000));
      },
    });
    const initial = campaignsExplorationOptions({
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request: requestFor('r1'),
    });
    const next = campaignsExplorationOptions({
      anchors: { campaignKeys: ['synthetic-campaign-9000'] },
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request: requestFor('r2'),
    });
    try {
      const old = await queryClient.fetchQuery(initial);
      await expect(queryClient.fetchQuery(next)).rejects.toThrow('bounded refresh window');
      expect(requests.filter((request) => request.revision === 'r2')).toHaveLength(5);
      expect(queryClient.getQueryData<CampaignExplorationData>(initial.queryKey)).toBe(old);
      expect(queryClient.getQueryData<CampaignExplorationData>(next.queryKey)).toBeUndefined();
      await expect(queryClient.fetchQuery(next)).rejects.toThrow('bounded refresh window');
      expect(requests.filter((request) => request.revision === 'r2')).toHaveLength(5);
    } finally {
      queryClient.clear();
    }
  });

  test('reports disappeared anchors only after the real end of the new result', async () => {
    const queryClient = createWebQueryClient();
    try {
      const data = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          anchors: { campaignKeys: ['deleted-campaign'], memberRowIds: { [campaignKey]: ['deleted-row'] } },
          client: clientWith(),
          intent: { ...initialSessionWindowIntent(), campaignSessionsDepth: { [campaignKey]: 1 } },
          queryClient,
          request: requestFor('r2'),
        }),
      );
      expect(data.list.pages.at(-1)?.nextCursor).toBeNull();
      expect(data.members[0]?.data.pages.at(-1)?.nextCursor).toBeNull();
      expect(data.missingAnchors).toEqual(['deleted-campaign', 'deleted-row']);
    } finally {
      queryClient.clear();
    }
  });

  test('never publishes a partial new revision when a later member page fails', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith({
      campaignChildren: (request) =>
        request.query.revision === 'r2' && request.query.cursor !== null
          ? Promise.reject(new Error('Member page unavailable'))
          : Promise.resolve(members(request)),
    });
    const intent = { ...initialSessionWindowIntent(), campaignSessionsDepth: { [campaignKey]: 2 }, topLevelDepth: 2 };
    const first = campaignsExplorationOptions({ client, intent, queryClient, request: requestFor('r1') });
    const next = campaignsExplorationOptions({ client, intent, queryClient, request: requestFor('r2') });
    try {
      const old = await queryClient.fetchQuery(first);
      await expect(queryClient.fetchQuery(next)).rejects.toThrow('Member page unavailable');
      expect(queryClient.getQueryData<CampaignExplorationData>(next.queryKey)).toBeUndefined();
      expect(queryClient.getQueryData<CampaignExplorationData>(first.queryKey)).toBe(old);
      expect(old.members[0]?.data.pages).toHaveLength(2);
    } finally {
      queryClient.clear();
    }
  });

  test('deduplicates concurrent requests for the same revision, scope and cursor', async () => {
    const queryClient = createWebQueryClient();
    const requests: (string | null)[] = [];
    const client = clientWith({
      page: (request) => {
        requests.push(request.cursor);
        return Promise.resolve(page(request));
      },
    });
    const options = campaignsExplorationOptions({
      client,
      intent: { ...initialSessionWindowIntent(), topLevelDepth: 3 },
      queryClient,
      request: requestFor('r1'),
    });
    try {
      const [first, second] = await Promise.all([queryClient.fetchQuery(options), queryClient.fetchQuery(options)]);
      expect(requests).toEqual([null, cursor(40), cursor(80)]);
      expect(first).toBe(second);
      expect(new Set(first.list.pages.flatMap((entry) => entry.items.map((item) => item.campaignKey))).size).toBe(120);
    } finally {
      queryClient.clear();
    }
  });

  test('rejects overlapping identities instead of silently dropping duplicates', async () => {
    const queryClient = createWebQueryClient();
    const client = clientWith({
      page: (request) => {
        const result = page(request);
        if (request.cursor === null) {
          return Promise.resolve(result);
        }
        return Promise.resolve({
          ...result,
          data: { ...result.data, items: page({ ...request, cursor: null }).data.items },
        });
      },
    });
    const observer = new InfiniteQueryObserver(queryClient, campaignsListOptions(client, requestFor('r1')));
    try {
      await observer.refetch();
      await expect(observer.fetchNextPage({ throwOnError: true })).rejects.toThrow('identity');
      expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
    } finally {
      observer.destroy();
      queryClient.clear();
    }
  });

  test('rejects an empty continuation and repeated member cursor without retry loops', async () => {
    const queryClient = createWebQueryClient();
    let calls = 0;
    const client = clientWith({
      page: (request) => {
        calls += 1;
        const result = page(request);
        return Promise.resolve(request.cursor === null ? result : { ...result, data: { ...result.data, items: [] } });
      },
      campaignChildren: (request) => {
        const result = members(request);
        return Promise.resolve(
          request.query.cursor === null
            ? result
            : { ...result, data: { ...result.data, nextCursor: request.query.cursor } },
        );
      },
    });
    const list = new InfiniteQueryObserver(queryClient, campaignsListOptions(client, requestFor('r1')));
    const descendants = new InfiniteQueryObserver(queryClient, campaignMembersOptions(client, 'r1', campaignKey));
    try {
      await list.refetch();
      await descendants.refetch();
      await expect(list.fetchNextPage({ throwOnError: true })).rejects.toThrow('empty page');
      await expect(descendants.fetchNextPage({ throwOnError: true })).rejects.toThrow('cursor');
      expect(calls).toBe(2);
      expect(list.getCurrentResult().data?.pages).toHaveLength(1);
      expect(descendants.getCurrentResult().data?.pages).toHaveLength(1);
    } finally {
      list.destroy();
      descendants.destroy();
      queryClient.clear();
    }
  });
});

describe('Campaign exact revision and cancellation', () => {
  test('restarts at null and uses only the new revision cursors during replay', async () => {
    const queryClient = createWebQueryClient();
    const seen: string[] = [];
    const client = clientWith({
      page: (request) => {
        const stamp = request.revision === 'r1' ? '1111111111111111' : '2222222222222222';
        if (request.cursor) {
          expect(request.cursor.split('.')[1]).toBe(stamp);
        }
        seen.push(`${request.revision}:${request.cursor ?? 'first'}`);
        const result = page(request);
        return Promise.resolve({
          ...result,
          data: { ...result.data, nextCursor: result.data.nextCursor?.replace('0000000000000000', stamp) ?? null },
        });
      },
    });
    try {
      for (const revision of ['r1', 'r2']) {
        await queryClient.fetchQuery(
          campaignsExplorationOptions({
            client,
            intent: { ...initialSessionWindowIntent(), topLevelDepth: 2 },
            queryClient,
            request: requestFor(revision),
          }),
        );
      }
      expect(seen).toEqual(['r1:first', 'r1:sq1.1111111111111111.40', 'r2:first', 'r2:sq1.2222222222222222.40']);
    } finally {
      queryClient.clear();
    }
  });

  test('expiration fails once and preserves the readable exact old result', async () => {
    const queryClient = createWebQueryClient();
    let calls = 0;
    const client = clientWith({
      page: (request) => {
        calls += 1;
        return request.revision === 'r1'
          ? Promise.resolve(page(request))
          : Promise.resolve({
              error: { tag: 'RevisionExpired', message: 'expired', revision: request.revision },
              ok: false,
              requestFingerprint: sessionQueryFingerprint(request),
              revision: request.revision,
            });
      },
    });
    const first = campaignsExplorationOptions({
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request: requestFor('r1'),
    });
    try {
      const old = await queryClient.fetchQuery(first);
      await expect(
        queryClient.fetchQuery(
          campaignsExplorationOptions({
            client,
            intent: initialSessionWindowIntent(),
            queryClient,
            request: requestFor('r2'),
          }),
        ),
      ).rejects.toThrow('expired');
      expect(calls).toBe(2);
      expect(queryClient.getQueryData<CampaignExplorationData>(first.queryKey)).toBe(old);
    } finally {
      queryClient.clear();
    }
  });

  test('cancels an old scope and never publishes its late response into a new filter', async () => {
    const queryClient = createWebQueryClient();
    let finishOld: ((value: ReturnType<typeof page>) => void) | undefined;
    let aborted = false;
    const oldRequest = requestFor('r1');
    const newRequest = { ...oldRequest, filters: { ...oldRequest.filters, query: 'needle' } };
    const client = clientWith({
      page: (request, signal) => {
        if (request.filters.query === 'needle') {
          return Promise.resolve(page(request, 1));
        }
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      },
    });
    const oldOptions = campaignsExplorationOptions({
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request: oldRequest,
    });
    const newOptions = campaignsExplorationOptions({
      client,
      intent: initialSessionWindowIntent(),
      queryClient,
      request: newRequest,
    });
    try {
      const old = queryClient.fetchQuery(oldOptions).catch((error: unknown) => error);
      await queryClient.cancelQueries({ exact: true, queryKey: oldOptions.queryKey });
      const next = await queryClient.fetchQuery(newOptions);
      finishOld?.(page(oldRequest));
      await old;
      expect(aborted).toBe(true);
      expect(queryClient.getQueryData<CampaignExplorationData>(oldOptions.queryKey)).toBeUndefined();
      expect(queryClient.getQueryData<CampaignExplorationData>(newOptions.queryKey)).toBe(next);
      expect(next.request.filters.query).toBe('needle');
      expect(next.list.pages[0]?.items).toHaveLength(1);
    } finally {
      queryClient.clear();
    }
  });
});
