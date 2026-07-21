import { describe, expect, test } from 'bun:test';
import {
  enrichSessionPresentationRow,
  type SessionNeighborRequest,
  type SessionPageItem,
  type SessionPageResult,
  type SessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { demoReportPayload } from './report-data';
import {
  buildDashboardSessionQueryScope,
  createSessionQueryCoordinator,
  type SessionQuerySource,
  type SessionQueryState,
  sessionRowsForState,
} from './session-query-client';
import {
  parseReportRequestFingerprint,
  parseReportRevision,
  reportManifestRequestFingerprint,
  type WebReportRevisionManifestResult,
} from './web-report-payload';

const rows = demoReportPayload.rows.map(enrichSessionPresentationRow);
const pagingRows = [rows[0]!, rows[1]!, rows[2]!, { ...rows[0]!, rowId: 'session-row-v1:0000000000000004' }];

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const manifest = (revision: string): WebReportRevisionManifestResult => ({
  manifest: {
    captureFingerprint: 'a'.repeat(64),
    expiresAt: 2,
    generatedAt: demoReportPayload.generatedAt,
    publishedAt: 1,
    revision: parseReportRevision(revision),
    rowsBytes: 1,
    supportBytes: 1,
  },
  ok: true,
  requestFingerprint: reportManifestRequestFingerprint,
});

const pageResult = (
  request: SessionQueryRequest,
  items: SessionPageItem[],
  nextCursor: string | null = null,
): {
  data: SessionPageResult;
  ok: true;
  requestFingerprint: string;
  revision: string;
} => {
  const data: SessionPageResult = {
    itemCount: items.length + (nextCursor ? 1 : 0),
    items,
    nextCursor,
    requestFingerprint: sessionQueryFingerprint(request),
    revision: request.revision,
    sessionCount: items.length + (nextCursor ? 1 : 0),
  };
  return {
    data,
    ok: true,
    requestFingerprint: data.requestFingerprint,
    revision: data.revision,
  };
};

const sourceWith = (overrides: Partial<SessionQuerySource>): SessionQuerySource => ({
  getCampaignChildren: () => Promise.reject(new Error('Unexpected campaign children request')),
  getManifest: () => Promise.resolve(manifest('revision-a')),
  getNeighbors: () => Promise.reject(new Error('Unexpected neighbor request')),
  getPage: () => Promise.reject(new Error('Unexpected page request')),
  ...overrides,
});

const scopeFor = (query = '') =>
  buildDashboardSessionQueryScope({
    campaigns: true,
    fields: {},
    harness: [],
    machine: [],
    query,
    range: { from: null, to: null },
    sorting: [{ desc: true, id: 'date' }],
  });

const scopeForSort = (query: string, desc: boolean) =>
  buildDashboardSessionQueryScope({
    campaigns: true,
    fields: {},
    harness: [],
    machine: [],
    query,
    range: { from: null, to: null },
    sorting: [{ desc, id: 'cost' }],
  });

describe('dashboard session query mapping', () => {
  test('maps filters, exact ISO bounds, campaign mode, sort, and a bounded page size', () => {
    const scope = buildDashboardSessionQueryScope({
      campaigns: false,
      fields: { model: 'gpt-5', project: 'ai-usage' },
      harness: ['codex', 'claude'],
      machine: ['workstation'],
      pageSize: 200,
      query: '  EXPENSIVE  ',
      range: {
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-13T23:59:59.999Z'),
      },
      sorting: [{ desc: false, id: 'cost' }],
    });

    expect(scope).toEqual({
      campaigns: false,
      filters: {
        fields: { model: 'gpt-5', project: 'ai-usage' },
        harness: ['claude', 'codex'],
        machine: ['workstation'],
        query: 'expensive',
      },
      pageSize: 200,
      range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-13T23:59:59.999Z' },
      sort: [{ desc: false, id: 'cost' }],
    });
  });

  test('rejects an unsupported sort or an oversized page before making a request', () => {
    expect(() =>
      buildDashboardSessionQueryScope({
        campaigns: true,
        fields: {},
        harness: [],
        machine: [],
        pageSize: 201,
        query: '',
        range: { from: null, to: null },
        sorting: [{ desc: true, id: 'date' }],
      }),
    ).toThrow('pageSize');
    expect(() =>
      buildDashboardSessionQueryScope({
        campaigns: true,
        fields: {},
        harness: [],
        machine: [],
        query: '',
        range: { from: null, to: null },
        sorting: [{ desc: true, id: 'not-a-column' }],
      }),
    ).toThrow('Unsupported session sort field');
  });
});

describe('served session query coordination', () => {
  test('rejects wrong response fingerprints and revisions', async () => {
    const wrongFingerprint = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) =>
          Promise.resolve({
            ...pageResult(request, [{ kind: 'session', row: rows[0]! }]),
            data: {
              ...pageResult(request, []).data,
              items: [{ kind: 'session' as const, row: rows[0]! }],
              requestFingerprint: 'session-query-v1:0000000000000000',
            },
          }),
      }),
    });
    await expect(wrongFingerprint.start(scopeFor())).rejects.toThrow('mismatched revision or request fingerprint');

    const wrongRevision = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) =>
          Promise.resolve({
            ...pageResult(request, []),
            data: { ...pageResult(request, []).data, revision: 'revision-b' },
          }),
      }),
    });
    await expect(wrongRevision.start(scopeFor())).rejects.toThrow('mismatched revision or request fingerprint');
  });

  test('ignores a stale first page that resolves after a newer query', async () => {
    const slowPage = deferred<ReturnType<typeof pageResult>>();
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) =>
          request.filters.query === 'slow'
            ? slowPage.promise
            : Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[1]! }])),
      }),
    });

    const first = coordinator.start(scopeFor('slow'));
    const second = await coordinator.start(scopeFor('fast'));
    const slowRequest = {
      ...scopeFor('slow'),
      cursor: null,
      revision: 'revision-a',
    } satisfies SessionQueryRequest;
    slowPage.resolve(pageResult(slowRequest, [{ kind: 'session', row: rows[0]! }]));
    await first;

    expect(second?.query.filters.query).toBe('fast');
    expect(sessionRowsForState(coordinator.state()).map((row) => row.rowId)).toEqual([rows[1]!.rowId]);
  });

  test('aborts rapid query and sort changes while publishing only the latest request', async () => {
    const slowPage = deferred<ReturnType<typeof pageResult>>();
    const signals: AbortSignal[] = [];
    const published: string[] = [];
    const coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (state) {
          published.push(`${state.query.filters.query}:${state.query.sort[0]?.desc}`);
        }
      },
      revision: () => 'revision-a',
      source: sourceWith({
        getPage: (request, signal) => {
          signals.push(signal);
          if (request.filters.query === 'slow') {
            signal.addEventListener('abort', () => slowPage.reject(signal.reason), { once: true });
            return slowPage.promise;
          }
          return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[1]! }]));
        },
      }),
    });

    const stale = coordinator.start(scopeForSort('slow', true));
    const latest = coordinator.start(scopeForSort('latest', false));
    const [staleResult, latestResult] = await Promise.allSettled([stale, latest]);

    expect(staleResult.status).toBe('fulfilled');
    expect(latestResult.status).toBe('fulfilled');
    expect(signals[0]?.aborted).toBe(true);
    expect(coordinator.state()?.query).toMatchObject({
      filters: { query: 'latest' },
      sort: [{ desc: false, id: 'cost' }],
    });
    expect(published).toEqual(['latest:false']);
  });

  test('keeps the active page visible when a staged revision fails', async () => {
    const published: string[][] = [];
    const coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (state) {
          published.push(sessionRowsForState(state).map((row) => row.rowId));
        }
      },
      revision: () => 'revision-a',
      source: sourceWith({
        getPage: (request) =>
          request.revision === 'revision-b'
            ? Promise.reject(new Error('staged destination failed'))
            : Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[0]! }])),
      }),
    });

    await coordinator.start(scopeFor());
    await expect(coordinator.prepare(scopeFor(), 'revision-b')).rejects.toThrow('staged destination failed');

    expect(coordinator.state()?.query.revision).toBe('revision-a');
    expect(sessionRowsForState(coordinator.state()).map((row) => row.rowId)).toEqual([rows[0]!.rowId]);
    expect(published).toEqual([[rows[0]!.rowId]]);
  });

  test('prepares a new first page without publishing it and commits once', async () => {
    const published: string[] = [];
    const coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (state) {
          published.push(`${state.query.revision}:${sessionRowsForState(state)[0]?.rowId ?? 'none'}`);
        }
      },
      revision: () => 'revision-a',
      source: sourceWith({
        getPage: (request) =>
          Promise.resolve(
            pageResult(request, [{ kind: 'session', row: request.revision === 'revision-a' ? rows[0]! : rows[2]! }]),
          ),
      }),
    });

    await coordinator.start(scopeFor());
    const prepared = await coordinator.prepare(scopeFor(), 'revision-b');

    expect(coordinator.state()?.query.revision).toBe('revision-a');
    expect(coordinator.canCommitPrepared(prepared)).toBe(true);
    expect(coordinator.commitPrepared(prepared)?.query.revision).toBe('revision-b');
    expect(coordinator.canCommitPrepared(prepared)).toBe(false);
    expect(coordinator.commitPrepared(prepared)).toBeUndefined();
    expect(published).toEqual([`revision-a:${rows[0]!.rowId}`, `revision-b:${rows[2]!.rowId}`]);
  });

  test('gives prepared requests identity so only the latest destination can commit', async () => {
    const coordinator = createSessionQueryCoordinator({
      revision: () => 'revision-a',
      source: sourceWith({
        getPage: (request) =>
          Promise.resolve(
            pageResult(request, [{ kind: 'session', row: request.revision === 'revision-b' ? rows[1]! : rows[2]! }]),
          ),
      }),
    });

    const first = await coordinator.prepare(scopeFor('first'), 'revision-b');
    const second = await coordinator.prepare(scopeFor('second'), 'revision-c');

    expect(first.requestId).not.toBe(second.requestId);
    expect(coordinator.canCommitPrepared(first)).toBe(false);
    expect(coordinator.canCommitPrepared(second)).toBe(true);
    expect(coordinator.commitPrepared(first)).toBeUndefined();
    expect(coordinator.commitPrepared(second)?.query.filters.query).toBe('second');
  });

  test('appends top-level pages without losing selection', async () => {
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) =>
          Promise.resolve(
            request.cursor === null
              ? pageResult(request, [{ kind: 'session', row: rows[0]! }], 'sq1.0000000000000000.1')
              : pageResult(request, [{ kind: 'session', row: rows[1]! }]),
          ),
      }),
    });

    await coordinator.start(scopeFor());
    coordinator.select(rows[0]!.rowId);
    const next = await coordinator.loadMore();

    expect(next?.selectedRowId).toBe(rows[0]!.rowId);
    expect(sessionRowsForState(next).map((row) => row.rowId)).toEqual([rows[0]!.rowId, rows[1]!.rowId]);
  });

  test('crosses more than two page boundaries in exact order and stops at the end', async () => {
    const cursors = [null, 'sq1.0000000000000000.1', 'sq1.0000000000000000.2', 'sq1.0000000000000000.3'];
    const requestedCursors: (string | null)[] = [];
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) => {
          requestedCursors.push(request.cursor);
          const pageIndex = cursors.indexOf(request.cursor);
          const nextCursor = cursors[pageIndex + 1] ?? null;
          const result = pageResult(request, [{ kind: 'session', row: pagingRows[pageIndex]! }], nextCursor);
          return Promise.resolve({
            ...result,
            data: { ...result.data, itemCount: pagingRows.length, sessionCount: pagingRows.length },
          });
        },
      }),
    });

    await coordinator.start(scopeFor());
    await coordinator.loadMore();
    await coordinator.loadMore();
    await coordinator.loadMore();
    const endState = await coordinator.loadMore();

    expect(requestedCursors).toEqual(cursors);
    expect(sessionRowsForState(endState).map((row) => row.rowId)).toEqual(pagingRows.map((row) => row.rowId));
    expect(new Set(sessionRowsForState(endState).map((row) => row.rowId)).size).toBe(pagingRows.length);
    expect(endState).toMatchObject({ itemCount: pagingRows.length, nextCursor: null, sessionCount: pagingRows.length });
  });

  test('coalesces concurrent load-more requests into one page fetch', async () => {
    const nextPage = deferred<ReturnType<typeof pageResult>>();
    let loadMoreRequest: SessionQueryRequest | undefined;
    let pageReads = 0;
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) => {
          pageReads += 1;
          if (request.cursor === null) {
            return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[0]! }], 'sq1.0000000000000000.1'));
          }
          loadMoreRequest = request;
          return nextPage.promise;
        },
      }),
    });
    await coordinator.start(scopeFor());

    const first = coordinator.loadMore();
    const second = coordinator.loadMore();
    expect(second).toBe(first);
    expect(pageReads).toBe(2);
    nextPage.resolve(pageResult(loadMoreRequest!, [{ kind: 'session', row: rows[1]! }]));

    const [firstState, secondState] = await Promise.all([first, second]);
    expect(firstState).toBe(secondState);
    expect(sessionRowsForState(firstState).map((row) => row.rowId)).toEqual([rows[0]!.rowId, rows[1]!.rowId]);
  });

  test('does not let a stale load-more cleanup release a newer generation request', async () => {
    const stalePage = deferred<ReturnType<typeof pageResult>>();
    const latestPage = deferred<ReturnType<typeof pageResult>>();
    let staleRequest: SessionQueryRequest | undefined;
    let latestRequest: SessionQueryRequest | undefined;
    const signals: AbortSignal[] = [];
    let pageReads = 0;
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request, signal) => {
          pageReads += 1;
          signals.push(signal);
          if (request.cursor === null) {
            const row = request.filters.query === 'stale' ? rows[0]! : rows[2]!;
            return Promise.resolve(pageResult(request, [{ kind: 'session', row }], 'sq1.0000000000000000.1'));
          }
          if (request.filters.query === 'stale') {
            staleRequest = request;
            return stalePage.promise;
          }
          latestRequest = request;
          return latestPage.promise;
        },
      }),
    });

    await coordinator.start(scopeFor('stale'));
    const staleLoad = coordinator.loadMore();
    await coordinator.start(scopeFor('latest'));
    const latestLoad = coordinator.loadMore();
    expect(coordinator.loadMore()).toBe(latestLoad);
    expect(signals[1]?.aborted).toBe(true);

    stalePage.resolve(pageResult(staleRequest!, [{ kind: 'session', row: rows[1]! }]));
    await staleLoad;
    expect(coordinator.state()).toMatchObject({ loadingMore: true, query: { filters: { query: 'latest' } } });
    expect(coordinator.loadMore()).toBe(latestLoad);
    expect(pageReads).toBe(4);

    latestPage.resolve(pageResult(latestRequest!, [{ kind: 'session', row: rows[1]! }]));
    const finalState = await latestLoad;
    expect(sessionRowsForState(finalState).map((row) => row.rowId)).toEqual([rows[2]!.rowId, rows[1]!.rowId]);
    expect(finalState?.loadingMore).toBe(false);
  });

  test('deduplicates repeated items within an incoming page', async () => {
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getPage: (request) =>
          Promise.resolve(
            request.cursor === null
              ? pageResult(request, [{ kind: 'session', row: rows[0]! }], 'sq1.0000000000000000.1')
              : pageResult(request, [
                  { kind: 'session', row: rows[1]! },
                  { kind: 'session', row: rows[1]! },
                  { kind: 'session', row: rows[0]! },
                  { kind: 'session', row: rows[2]! },
                  { kind: 'session', row: rows[2]! },
                ]),
          ),
      }),
    });

    await coordinator.start(scopeFor());
    const state = await coordinator.loadMore();

    expect(sessionRowsForState(state).map((row) => row.rowId)).toEqual([
      rows[0]!.rowId,
      rows[1]!.rowId,
      rows[2]!.rowId,
    ]);
  });

  test('accepts the next page request immediately after publishing the previous page', async () => {
    const followUpLoads: Promise<SessionQueryState | undefined>[] = [];
    const requestedCursors: (string | null)[] = [];
    let coordinator: ReturnType<typeof createSessionQueryCoordinator>;
    coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (state?.nextCursor && !state.loadingMore) {
          followUpLoads.push(coordinator.loadMore());
        }
      },
      source: sourceWith({
        getPage: (request) => {
          requestedCursors.push(request.cursor);
          const pageIndex = requestedCursors.length - 1;
          const nextCursor = pageIndex < 2 ? `sq1.0000000000000000.${pageIndex + 1}` : null;
          return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[pageIndex]! }], nextCursor));
        },
      }),
    });

    await coordinator.start(scopeFor());
    await Promise.all(followUpLoads);
    await Promise.all(followUpLoads);

    expect(requestedCursors).toEqual([null, 'sq1.0000000000000000.1', 'sq1.0000000000000000.2']);
    expect(sessionRowsForState(coordinator.state()).map((row) => row.rowId)).toEqual([
      rows[0]!.rowId,
      rows[1]!.rowId,
      rows[2]!.rowId,
    ]);
  });

  test('releases a failed load-more before publishing its cleanup state', async () => {
    let armed = false;
    let pageReads = 0;
    let retryRequested = false;
    let retry: Promise<SessionQueryState | undefined> | undefined;
    let coordinator: ReturnType<typeof createSessionQueryCoordinator>;
    coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (armed && state?.nextCursor && !state.loadingMore && !retryRequested) {
          retryRequested = true;
          retry = coordinator.loadMore();
        }
      },
      source: sourceWith({
        getPage: (request) => {
          pageReads += 1;
          if (request.cursor === null) {
            return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[0]! }], 'sq1.0000000000000000.1'));
          }
          if (pageReads === 2) {
            return Promise.reject(new Error('first page continuation failed'));
          }
          return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[1]! }]));
        },
      }),
    });
    await coordinator.start(scopeFor());
    armed = true;

    await expect(coordinator.loadMore()).rejects.toThrow('first page continuation failed');
    if (!retry) {
      throw new Error('The cleanup publication did not start a fresh load-more request');
    }
    const finalState = await retry;

    expect(pageReads).toBe(3);
    expect(finalState?.loadingMore).toBe(false);
    expect(sessionRowsForState(finalState).map((row) => row.rowId)).toEqual([rows[0]!.rowId, rows[1]!.rowId]);
  });

  test('loads bounded campaign children incrementally', async () => {
    const campaignKey = 'machine:codex:root';
    const campaignRow = { ...rows[0]!, campaignKey };
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getCampaignChildren: (request) =>
          Promise.resolve({
            data: {
              campaignKey,
              itemCount: 2,
              items: request.query.cursor === null ? [rows[1]!, rows[1]!] : [rows[2]!, rows[2]!],
              nextCursor: request.query.cursor === null ? 'sq1.0000000000000000.1' : null,
              requestFingerprint: sessionCampaignChildrenFingerprint(request),
              revision: request.query.revision,
              sessionCount: 2,
            },
            ok: true,
            requestFingerprint: sessionCampaignChildrenFingerprint(request),
            revision: request.query.revision,
          }),
        getPage: (request) =>
          Promise.resolve(pageResult(request, [{ campaignKey, kind: 'campaign', row: campaignRow }])),
      }),
    });

    await coordinator.start(scopeFor());
    await coordinator.loadCampaignChildren(campaignKey);
    const next = await coordinator.loadCampaignChildren(campaignKey);

    expect(next?.campaignChildren.get(campaignKey)).toMatchObject({ loading: false, nextCursor: null, totalCount: 2 });
    expect(sessionRowsForState(next)[0]?.children?.map((row) => row.rowId)).toEqual([rows[1]!.rowId, rows[2]!.rowId]);
  });

  test('does not let stale campaign cleanup release a newer generation request', async () => {
    const campaignKey = 'machine:codex:replacement';
    const campaignRow = { ...rows[0]!, campaignKey };
    const staleChildren = deferred<Awaited<ReturnType<SessionQuerySource['getCampaignChildren']>>>();
    const latestChildren = deferred<Awaited<ReturnType<SessionQuerySource['getCampaignChildren']>>>();
    let staleRequest: Parameters<SessionQuerySource['getCampaignChildren']>[0] | undefined;
    let latestRequest: Parameters<SessionQuerySource['getCampaignChildren']>[0] | undefined;
    let childReads = 0;
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getCampaignChildren: (request) => {
          childReads += 1;
          if (request.query.filters.query === 'stale') {
            staleRequest = request;
            return staleChildren.promise;
          }
          latestRequest = request;
          return latestChildren.promise;
        },
        getPage: (request) =>
          Promise.resolve(pageResult(request, [{ campaignKey, kind: 'campaign', row: campaignRow }])),
      }),
    });

    await coordinator.start(scopeFor('stale'));
    const staleLoad = coordinator.loadCampaignChildren(campaignKey);
    await coordinator.start(scopeFor('latest'));
    const latestLoad = coordinator.loadCampaignChildren(campaignKey);
    expect(coordinator.loadCampaignChildren(campaignKey)).toBe(latestLoad);

    staleChildren.resolve({
      data: {
        campaignKey,
        itemCount: 1,
        items: [rows[1]!],
        nextCursor: null,
        requestFingerprint: sessionCampaignChildrenFingerprint(staleRequest!),
        revision: staleRequest!.query.revision,
        sessionCount: 1,
      },
      ok: true,
      requestFingerprint: sessionCampaignChildrenFingerprint(staleRequest!),
      revision: staleRequest!.query.revision,
    });
    await staleLoad;

    expect(coordinator.loadCampaignChildren(campaignKey)).toBe(latestLoad);
    expect(childReads).toBe(2);

    latestChildren.resolve({
      data: {
        campaignKey,
        itemCount: 1,
        items: [rows[2]!],
        nextCursor: null,
        requestFingerprint: sessionCampaignChildrenFingerprint(latestRequest!),
        revision: latestRequest!.query.revision,
        sessionCount: 1,
      },
      ok: true,
      requestFingerprint: sessionCampaignChildrenFingerprint(latestRequest!),
      revision: latestRequest!.query.revision,
    });
    const finalState = await latestLoad;

    expect(finalState?.campaignChildren.get(campaignKey)?.items.map((row) => row.rowId)).toEqual([rows[2]!.rowId]);
  });

  test('releases a failed campaign request before publishing its cleanup state', async () => {
    const campaignKey = 'machine:codex:retry';
    const campaignRow = { ...rows[0]!, campaignKey };
    let armed = false;
    let childReads = 0;
    let retryRequested = false;
    let retry: Promise<SessionQueryState | undefined> | undefined;
    let coordinator: ReturnType<typeof createSessionQueryCoordinator>;
    coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        const children = state?.campaignChildren.get(campaignKey);
        if (armed && state && !children?.loading && !retryRequested) {
          retryRequested = true;
          retry = coordinator.loadCampaignChildren(campaignKey);
        }
      },
      source: sourceWith({
        getCampaignChildren: (request) => {
          childReads += 1;
          if (childReads === 1) {
            return Promise.reject(new Error('first campaign request failed'));
          }
          return Promise.resolve({
            data: {
              campaignKey,
              itemCount: 1,
              items: [rows[1]!],
              nextCursor: null,
              requestFingerprint: sessionCampaignChildrenFingerprint(request),
              revision: request.query.revision,
              sessionCount: 1,
            },
            ok: true,
            requestFingerprint: sessionCampaignChildrenFingerprint(request),
            revision: request.query.revision,
          });
        },
        getPage: (request) =>
          Promise.resolve(pageResult(request, [{ campaignKey, kind: 'campaign', row: campaignRow }])),
      }),
    });
    await coordinator.start(scopeFor());
    armed = true;

    await expect(coordinator.loadCampaignChildren(campaignKey)).rejects.toThrow('first campaign request failed');
    if (!retry) {
      throw new Error('The cleanup publication did not start a fresh campaign request');
    }
    const finalState = await retry;

    expect(childReads).toBe(2);
    expect(finalState?.campaignChildren.get(campaignKey)).toMatchObject({ loading: false, nextCursor: null });
  });

  test('returns exact-revision neighbors over the full filtered sequence', async () => {
    const requests: SessionNeighborRequest[] = [];
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getNeighbors: (request) => {
          requests.push(request);
          return Promise.resolve({
            data: {
              found: true,
              next: rows[2]!,
              previous: rows[0]!,
              requestFingerprint: sessionNeighborFingerprint(request),
              revision: request.query.revision,
            },
            ok: true,
            requestFingerprint: sessionNeighborFingerprint(request),
            revision: request.query.revision,
          });
        },
        getPage: (request) => Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[1]! }])),
      }),
    });
    await coordinator.start(scopeFor('needle'));

    const neighbors = await coordinator.loadNeighbors(rows[1]!.rowId);

    expect(neighbors?.previous?.rowId).toBe(rows[0]!.rowId);
    expect(neighbors?.next?.rowId).toBe(rows[2]!.rowId);
    expect(requests[0]?.query).toMatchObject({ cursor: null, filters: { query: 'needle' }, revision: 'revision-a' });
  });

  test('discards partial pages and restarts from a fresh manifest after expiry', async () => {
    let manifestReads = 0;
    let pageReads = 0;
    const published: (string[] | undefined)[] = [];
    const coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => published.push(state && sessionRowsForState(state).map((row) => row.rowId)),
      source: sourceWith({
        getManifest: () => {
          manifestReads += 1;
          return Promise.resolve(manifest(manifestReads === 1 ? 'revision-a' : 'revision-b'));
        },
        getPage: (request) => {
          pageReads += 1;
          if (pageReads === 1) {
            return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[0]! }], 'sq1.0000000000000000.1'));
          }
          if (request.revision === 'revision-a') {
            return Promise.resolve({
              error: {
                message: 'expired',
                revision: parseReportRevision('revision-a'),
                tag: 'RevisionExpired',
              },
              ok: false,
              requestFingerprint: sessionQueryFingerprint(request),
              revision: parseReportRevision('revision-a'),
            });
          }
          return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[2]! }]));
        },
      }),
    });

    await coordinator.start(scopeFor());
    const restarted = await coordinator.loadMore();

    expect(restarted?.query.revision).toBe('revision-b');
    expect(sessionRowsForState(restarted).map((row) => row.rowId)).toEqual([rows[2]!.rowId]);
    expect(published).toEqual([[rows[0]!.rowId], [rows[0]!.rowId], [rows[2]!.rowId]]);
  });

  test('pins Sessions to the focused store revision and restarts both through one expiry callback', async () => {
    let focusedRevision = 'revision-a';
    let manifestReads = 0;
    const requested: string[] = [];
    const coordinator = createSessionQueryCoordinator({
      onRevisionExpired: () => {
        focusedRevision = 'revision-b';
        return Promise.resolve();
      },
      revision: () => focusedRevision,
      source: sourceWith({
        getManifest: () => {
          manifestReads += 1;
          return Promise.resolve(manifest('unexpected-manifest'));
        },
        getPage: (request) => {
          requested.push(request.revision);
          if (request.revision === 'revision-a' && request.cursor !== null) {
            return Promise.resolve({
              error: {
                message: 'expired',
                revision: parseReportRevision('revision-a'),
                tag: 'RevisionExpired',
              },
              ok: false,
              requestFingerprint: sessionQueryFingerprint(request),
              revision: request.revision,
            });
          }
          return Promise.resolve(
            pageResult(
              request,
              [{ kind: 'session', row: request.revision === 'revision-a' ? rows[0]! : rows[2]! }],
              request.revision === 'revision-a' ? 'sq1.0000000000000000.1' : null,
            ),
          );
        },
      }),
    });

    await coordinator.start(scopeFor());
    const restarted = await coordinator.loadMore();

    expect(manifestReads).toBe(0);
    expect(requested).toEqual(['revision-a', 'revision-a', 'revision-b']);
    expect(restarted?.query.revision).toBe('revision-b');
    expect(sessionRowsForState(restarted).map((row) => row.rowId)).toEqual([rows[2]!.rowId]);
  });

  test('clears load-more state when a revision restart fails', async () => {
    const coordinator = createSessionQueryCoordinator({
      onRevisionExpired: () => Promise.reject(new Error('focused refresh failed')),
      source: sourceWith({
        getPage: (request) => {
          if (request.cursor === null) {
            return Promise.resolve(pageResult(request, [{ kind: 'session', row: rows[0]! }], 'sq1.0000000000000000.1'));
          }
          return Promise.resolve({
            error: {
              message: 'expired',
              revision: parseReportRevision(request.revision),
              tag: 'RevisionExpired' as const,
            },
            ok: false as const,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: parseReportRevision(request.revision),
          });
        },
      }),
    });
    await coordinator.start(scopeFor());

    await expect(coordinator.loadMore()).rejects.toThrow('focused refresh failed');

    expect(coordinator.state()?.loadingMore).toBe(false);
  });

  test('clears campaign loading state when a revision restart fails', async () => {
    const campaignKey = 'machine:codex:expired';
    const campaignRow = { ...rows[0]!, campaignKey };
    const coordinator = createSessionQueryCoordinator({
      onRevisionExpired: () => Promise.reject(new Error('focused refresh failed')),
      source: sourceWith({
        getCampaignChildren: (request) =>
          Promise.resolve({
            error: {
              message: 'expired',
              revision: parseReportRevision(request.query.revision),
              tag: 'RevisionExpired' as const,
            },
            ok: false as const,
            requestFingerprint: sessionCampaignChildrenFingerprint(request),
            revision: parseReportRevision(request.query.revision),
          }),
        getPage: (request) =>
          Promise.resolve(pageResult(request, [{ campaignKey, kind: 'campaign', row: campaignRow }])),
      }),
    });
    await coordinator.start(scopeFor());

    await expect(coordinator.loadCampaignChildren(campaignKey)).rejects.toThrow('focused refresh failed');

    expect(coordinator.state()?.campaignChildren.get(campaignKey)?.loading ?? false).toBe(false);
  });

  test('closes idempotently, aborts an initial page, and prevents late publication', async () => {
    const firstPage = deferred<ReturnType<typeof pageResult>>();
    const published: SessionQueryState[] = [];
    let request: SessionQueryRequest | undefined;
    let signal: AbortSignal | undefined;
    let pageReads = 0;
    const coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (state) {
          published.push(state);
        }
      },
      revision: () => 'revision-a',
      source: sourceWith({
        getPage: (nextRequest, nextSignal) => {
          pageReads += 1;
          request = nextRequest;
          signal = nextSignal;
          return firstPage.promise;
        },
      }),
    });

    const start = coordinator.start(scopeFor());
    coordinator.close();
    coordinator.close();
    expect(signal?.aborted).toBe(true);
    firstPage.resolve(pageResult(request!, [{ kind: 'session', row: rows[0]! }]));

    await expect(start).resolves.toBeUndefined();
    await expect(coordinator.start(scopeFor('after-close'))).resolves.toBeUndefined();
    expect(pageReads).toBe(1);
    expect(published).toEqual([]);
  });

  test('close aborts staged, paging, child, and neighbor work without late state changes', async () => {
    const campaignKey = 'machine:codex:close';
    const campaignRow = { ...rows[0]!, campaignKey };
    const page = deferred<ReturnType<typeof pageResult>>();
    const preparedPage = deferred<ReturnType<typeof pageResult>>();
    const children = deferred<Awaited<ReturnType<SessionQuerySource['getCampaignChildren']>>>();
    const neighbors = deferred<Awaited<ReturnType<SessionQuerySource['getNeighbors']>>>();
    const signals = new Map<string, AbortSignal>();
    let pageRequest: SessionQueryRequest | undefined;
    let prepareRequest: SessionQueryRequest | undefined;
    let childrenRequest: Parameters<SessionQuerySource['getCampaignChildren']>[0] | undefined;
    let neighborRequest: SessionNeighborRequest | undefined;
    const published: SessionQueryState[] = [];
    const coordinator = createSessionQueryCoordinator({
      onStateChange: (state) => {
        if (state) {
          published.push(state);
        }
      },
      revision: () => 'revision-a',
      source: sourceWith({
        getCampaignChildren: (request, signal) => {
          childrenRequest = request;
          signals.set('children', signal);
          return children.promise;
        },
        getNeighbors: (request, signal) => {
          neighborRequest = request;
          signals.set('neighbors', signal);
          return neighbors.promise;
        },
        getPage: (request, signal) => {
          if (request.revision === 'revision-b') {
            prepareRequest = request;
            signals.set('prepare', signal);
            return preparedPage.promise;
          }
          if (request.cursor !== null) {
            pageRequest = request;
            signals.set('page', signal);
            return page.promise;
          }
          return Promise.resolve(
            pageResult(request, [{ campaignKey, kind: 'campaign', row: campaignRow }], 'sq1.0000000000000000.1'),
          );
        },
      }),
    });
    await coordinator.start(scopeFor());

    const paging = coordinator.loadMore();
    const childLoad = coordinator.loadCampaignChildren(campaignKey);
    const neighborLoad = coordinator.loadNeighbors(rows[0]!.rowId);
    const prepare = coordinator.prepare(scopeFor('prepared'), 'revision-b');
    const prepareOutcome = (async (): Promise<string> => {
      try {
        await prepare;
        return 'fulfilled';
      } catch (error) {
        return error instanceof DOMException ? error.name : 'rejected';
      }
    })();
    const publicationCountAtClose = published.length;
    coordinator.close();

    expect([...signals.values()].every((operationSignal) => operationSignal.aborted)).toBe(true);
    page.resolve(pageResult(pageRequest!, [{ kind: 'session', row: rows[1]! }]));
    preparedPage.resolve(pageResult(prepareRequest!, [{ kind: 'session', row: rows[2]! }]));
    children.resolve({
      data: {
        campaignKey,
        itemCount: 1,
        items: [rows[1]!],
        nextCursor: null,
        requestFingerprint: sessionCampaignChildrenFingerprint(childrenRequest!),
        revision: childrenRequest!.query.revision,
        sessionCount: 1,
      },
      ok: true,
      requestFingerprint: sessionCampaignChildrenFingerprint(childrenRequest!),
      revision: childrenRequest!.query.revision,
    });
    neighbors.resolve({
      data: {
        found: true,
        next: rows[1]!,
        previous: null,
        requestFingerprint: sessionNeighborFingerprint(neighborRequest!),
        revision: neighborRequest!.query.revision,
      },
      ok: true,
      requestFingerprint: sessionNeighborFingerprint(neighborRequest!),
      revision: neighborRequest!.query.revision,
    });

    await Promise.all([paging, childLoad, neighborLoad]);
    expect(await prepareOutcome).toBe('AbortError');
    expect(published).toHaveLength(publicationCountAtClose);
  });

  test('rejects a manifest fingerprint before issuing a session query', async () => {
    let pageReads = 0;
    const coordinator = createSessionQueryCoordinator({
      source: sourceWith({
        getManifest: () =>
          Promise.resolve({
            ...manifest('revision-a'),
            requestFingerprint: parseReportRequestFingerprint('report-manifest:v1:{wrong}'),
          }),
        getPage: (request) => {
          pageReads += 1;
          return Promise.resolve(pageResult(request, []));
        },
      }),
    });

    await expect(coordinator.start(scopeFor())).rejects.toThrow('manifest request fingerprint mismatch');
    expect(pageReads).toBe(0);
  });
});
