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

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
    expect(published).toEqual([`revision-a:${rows[0]!.rowId}`, `revision-b:${rows[2]!.rowId}`]);
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
              items: [request.query.cursor === null ? rows[1]! : rows[2]!],
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
