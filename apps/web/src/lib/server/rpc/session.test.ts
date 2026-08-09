import { describe, expect, test } from 'bun:test';
import {
  parseSessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import { createSessionRpcRouter, type SessionRpcDependencies } from './session';

const query = parseSessionQueryRequest({
  cursor: null,
  filters: {
    fields: {},
    harness: [],
    machine: [],
    query: '',
  },
  pageSize: 25,
  range: { from: null, to: null },
  revision: 'revision-1',
  sort: [{ desc: true, id: 'date' }],
});

const pageEnvelope = (request = query) => {
  const requestFingerprint = sessionQueryFingerprint(request);
  return {
    data: {
      itemCount: 0,
      items: [],
      nextCursor: null,
      requestFingerprint,
      revision: request.revision,
      sessionCount: 0,
    },
    ok: true as const,
    requestFingerprint,
    revision: request.revision,
  };
};

const campaignRequest = { campaignKey: 'campaign-1', query };
const campaignEnvelope = () => {
  const requestFingerprint = sessionCampaignChildrenFingerprint(campaignRequest);
  return {
    data: {
      campaignKey: campaignRequest.campaignKey,
      itemCount: 0,
      items: [],
      nextCursor: null,
      requestFingerprint,
      revision: query.revision,
      root: null,
      sessionCount: 0,
    },
    ok: true as const,
    requestFingerprint,
    revision: query.revision,
  };
};

const neighborRequest = { query, rowId: 'row-1' };
const neighborEnvelope = () => {
  const requestFingerprint = sessionNeighborFingerprint(neighborRequest);
  return {
    data: {
      found: false,
      next: null,
      previous: null,
      requestFingerprint,
      revision: query.revision,
    },
    ok: true as const,
    requestFingerprint,
    revision: query.revision,
  };
};

const detailUnavailable = {
  message: 'Local history is unavailable.',
  reason: 'history-unavailable' as const,
  status: 'unavailable' as const,
};
const vcsUnavailable = { reason: 'not-local' as const, status: 'unavailable' as const };

const catchError = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail');
};

const requireOrpcError = (error: unknown): ORPCError<string, unknown> => {
  if (!(error instanceof ORPCError)) {
    throw new Error('Expected an ORPCError');
  }
  return error;
};

describe('Session RPC server adapter', () => {
  test('routes all five procedures through their narrow deep ports with canonical inputs', async () => {
    const calls: Array<{ kind: string; request: unknown; signal: AbortSignal | undefined }> = [];
    const dependencies: SessionRpcDependencies = {
      getDetail: (request, signal) => {
        calls.push({ kind: 'detail', request, signal });
        return Promise.resolve(detailUnavailable);
      },
      resolveVcs: (request, signal) => {
        calls.push({ kind: 'vcs', request, signal });
        return Promise.resolve(vcsUnavailable);
      },
      runRevisionQuery: (kind, request, signal) => {
        calls.push({ kind, request, signal });
        if (kind === 'campaign-children') {
          return Promise.resolve(campaignEnvelope());
        }
        if (kind === 'neighbors') {
          return Promise.resolve(neighborEnvelope());
        }
        return Promise.resolve(pageEnvelope());
      },
    };
    const router = createSessionRpcRouter(dependencies);
    const controller = new AbortController();

    expect(await call(router.page, query, { signal: controller.signal })).toEqual(pageEnvelope());
    expect(await call(router.campaignChildren, campaignRequest, { signal: controller.signal })).toEqual(
      campaignEnvelope(),
    );
    expect(await call(router.neighbors, neighborRequest, { signal: controller.signal })).toEqual(neighborEnvelope());
    expect(
      await call(router.detail, { revision: query.revision, rowId: 'row-1' }, { signal: controller.signal }),
    ).toEqual(detailUnavailable);
    expect(await call(router.vcs, { revision: query.revision, rowId: 'row-1' }, { signal: controller.signal })).toEqual(
      vcsUnavailable,
    );

    expect(calls.map(({ kind }) => kind)).toEqual(['sessions', 'campaign-children', 'neighbors', 'detail', 'vcs']);
    expect(calls.every(({ signal }) => signal === controller.signal)).toBe(true);
    expect(calls[0]?.request).toEqual(query);
  });

  test('preserves exact-query protocol error envelopes and rejects stale identities', async () => {
    const incompatibleRouter = createSessionRpcRouter({
      getDetail: async () => detailUnavailable,
      resolveVcs: async () => vcsUnavailable,
      runRevisionQuery: async () => ({ ...pageEnvelope(), revision: 'stale-revision' }),
    });
    const invalidError = requireOrpcError(await catchError(call(incompatibleRouter.page, query)));
    expect(invalidError.code).toBe('IncompatibleStore');
    expect(invalidError.data).toEqual({ reason: 'incompatible-store' });
    expect(invalidError.message).not.toContain('stale-revision');

    const requestFingerprint = sessionQueryFingerprint(query);
    const revisionExpiredEnvelope = {
      error: {
        message: `revision expired: ${'x'.repeat(513)}`,
        revision: query.revision,
        tag: 'RevisionExpired' as const,
      },
      ok: false as const,
      requestFingerprint,
      revision: query.revision,
    };
    const queryFailedEnvelope = {
      error: {
        message: 'The exact query could not be completed.',
        revision: query.revision,
        tag: 'QueryFailed' as const,
      },
      ok: false as const,
      requestFingerprint,
      revision: query.revision,
    };
    let invocation = 0;
    const protocolErrorRouter = createSessionRpcRouter({
      getDetail: async () => detailUnavailable,
      resolveVcs: async () => vcsUnavailable,
      runRevisionQuery: () => {
        invocation += 1;
        return Promise.resolve(invocation === 1 ? revisionExpiredEnvelope : queryFailedEnvelope);
      },
    });

    expect(await call(protocolErrorRouter.page, query)).toEqual(revisionExpiredEnvelope);
    expect(await call(protocolErrorRouter.page, query)).toEqual(queryFailedEnvelope);
    expect(revisionExpiredEnvelope.error.message.length).toBeGreaterThan(512);
  });
  test('sanitizes private deep-port failures and invalid local-read output', async () => {
    const privatePath = '/private/home/history.jsonl';
    const router = createSessionRpcRouter({
      getDetail: () => Promise.reject(new Error(privatePath)),
      resolveVcs: async () => ({ repositoryUrl: `file://${privatePath}`, status: 'available' }),
      runRevisionQuery: () => Promise.reject(new Error(privatePath)),
    });

    const pageError = requireOrpcError(await catchError(call(router.page, query)));
    expect(pageError.code).toBe('IncompatibleStore');
    expect(pageError.message).not.toContain(privatePath);

    const detailError = requireOrpcError(
      await catchError(call(router.detail, { revision: query.revision, rowId: 'row-1' })),
    );
    expect(detailError.code).toBe('Unavailable');
    expect(detailError.message).not.toContain(privatePath);

    const vcsError = requireOrpcError(await catchError(call(router.vcs, { revision: query.revision, rowId: 'row-1' })));
    expect(vcsError.code).toBe('Unavailable');
    expect(vcsError.message).not.toContain(privatePath);
  });

  test('forwards cancellation without translating it to a public domain error', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('superseded', 'AbortError');
    let receivedSignal: AbortSignal | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const router = createSessionRpcRouter({
      getDetail: async () => detailUnavailable,
      resolveVcs: async () => vcsUnavailable,
      runRevisionQuery: async (_kind, _request, signal) => {
        receivedSignal = signal;
        signalStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('concurrent deep failure')), { once: true });
        });
      },
    });

    const pendingError = catchError(call(router.page, query, { signal: controller.signal }));
    await started;
    controller.abort(abortReason);
    expect(await pendingError).toBe(abortReason);
    expect(receivedSignal).toBe(controller.signal);
  });

  test('keeps superseded and current revisions isolated', async () => {
    const currentQuery = parseSessionQueryRequest({ ...query, revision: 'revision-2' });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const abortReason = new DOMException('superseded', 'AbortError');
    let invocation = 0;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const router = createSessionRpcRouter({
      getDetail: async () => detailUnavailable,
      resolveVcs: async () => vcsUnavailable,
      runRevisionQuery: async (_kind, _request, signal) => {
        invocation += 1;
        if (invocation === 2) {
          return pageEnvelope(currentQuery);
        }
        firstStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const staleError = catchError(call(router.page, query, { signal: firstController.signal }));
    await firstStartedPromise;
    const current = call(router.page, currentQuery, { signal: secondController.signal });
    expect(await current).toEqual(pageEnvelope(currentQuery));
    firstController.abort(abortReason);

    expect(await staleError).toBe(abortReason);
    expect(secondController.signal.aborted).toBe(false);
  });

  test('preserves unavailable trust semantics from detail and VCS owners', async () => {
    const router = createSessionRpcRouter({
      getDetail: async () => detailUnavailable,
      resolveVcs: async () => vcsUnavailable,
      runRevisionQuery: async () => pageEnvelope(),
    });

    expect(await call(router.detail, { revision: query.revision, rowId: 'row-1' })).toEqual(detailUnavailable);
    expect(await call(router.vcs, { revision: query.revision, rowId: 'row-1' })).toEqual(vcsUnavailable);
  });
});
