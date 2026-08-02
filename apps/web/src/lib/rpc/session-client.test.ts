import { describe, expect, test } from 'bun:test';
import { type SessionDetailResponse, SessionDetailValidationError } from '@ai-usage/report-core/session-detail';
import {
  parseSessionQueryRequest,
  SessionQueryValidationError,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { createSessionClientAdapter, type SessionRpcTransport } from './session-client';

const rawQuery = {
  cursor: null,
  filters: {
    fields: {},
    harness: ['codex', 'claude', 'codex'],
    machine: [],
    query: '  SEARCH  ',
  },
  pageSize: 25,
  range: { from: null, to: null },
  revision: 'revision-1',
  sort: [{ desc: true, id: 'date' as const }],
};
const query = parseSessionQueryRequest(rawQuery);
const campaignRequest = { campaignKey: 'campaign-1', query };
const neighborRequest = { query, rowId: 'row-1' };
const detailUnavailable = {
  message: 'Local history is unavailable.',
  reason: 'history-unavailable' as const,
  status: 'unavailable' as const,
};
const vcsUnavailable = { reason: 'not-local' as const, status: 'unavailable' as const };

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
      sessionCount: 0,
    },
    ok: true as const,
    requestFingerprint,
    revision: query.revision,
  };
};

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

const availableDetail = {
  consistency: { checkedFields: ['tokens'], status: 'matches-report' },
  detail: {
    activeDurationMs: null,
    durationStatus: 'unavailable',
    efforts: [],
    elapsedDurationMs: 60_000,
    endedAt: '2026-07-18T10:01:00.000Z',
    idleDurationMs: null,
    models: [],
    observedAt: '2026-07-18T10:01:01.000Z',
    phases: [],
    prompts: [],
    promptsTruncated: false,
    sourceSessionId: 'session-a',
    startedAt: '2026-07-18T10:00:00.000Z',
    turns: [],
    turnsStatus: 'recorded',
  },
  revision: query.revision,
  status: 'available',
} satisfies SessionDetailResponse;

const defaultTransport = (): SessionRpcTransport => ({
  campaignChildren: () => Promise.resolve(campaignEnvelope()),
  detail: () => Promise.resolve(detailUnavailable),
  neighbors: () => Promise.resolve(neighborEnvelope()),
  page: () => Promise.resolve(pageEnvelope()),
  vcs: () => Promise.resolve(vcsUnavailable),
});

describe('Session RPC browser adapter', () => {
  test('canonicalizes each exact input and forwards the caller signal', async () => {
    const calls: Array<{ input: unknown; name: string; signal: AbortSignal | undefined }> = [];
    const transport: SessionRpcTransport = {
      campaignChildren: (input, options) => {
        calls.push({ input, name: 'campaignChildren', signal: options?.signal });
        return Promise.resolve(campaignEnvelope());
      },
      detail: (input, options) => {
        calls.push({ input, name: 'detail', signal: options?.signal });
        return Promise.resolve(detailUnavailable);
      },
      neighbors: (input, options) => {
        calls.push({ input, name: 'neighbors', signal: options?.signal });
        return Promise.resolve(neighborEnvelope());
      },
      page: (input, options) => {
        calls.push({ input, name: 'page', signal: options?.signal });
        return Promise.resolve(pageEnvelope());
      },
      vcs: (input, options) => {
        calls.push({ input, name: 'vcs', signal: options?.signal });
        return Promise.resolve(vcsUnavailable);
      },
    };
    const adapter = createSessionClientAdapter(transport);
    const controller = new AbortController();

    await adapter.page(rawQuery, controller.signal);
    await adapter.campaignChildren(campaignRequest, controller.signal);
    await adapter.neighbors(neighborRequest, controller.signal);
    await adapter.detail({ revision: query.revision, rowId: 'row-1' }, controller.signal);
    await adapter.vcs({ revision: query.revision, rowId: 'row-1' }, controller.signal);

    expect(calls.map(({ name }) => name)).toEqual(['page', 'campaignChildren', 'neighbors', 'detail', 'vcs']);
    expect(calls.every(({ signal }) => signal === controller.signal)).toBe(true);
    expect(calls[0]?.input).toEqual(query);
    expect(JSON.stringify(calls)).not.toContain('privatePath');
  });

  test('rejects stale revision or fingerprint identities for every exact query', async () => {
    const transport: SessionRpcTransport = {
      ...defaultTransport(),
      campaignChildren: () => Promise.resolve({ ...campaignEnvelope(), revision: 'stale-revision' }),
      neighbors: () => Promise.resolve({ ...neighborEnvelope(), requestFingerprint: 'stale-fingerprint' }),
      page: () => Promise.resolve({ ...pageEnvelope(), revision: 'stale-revision' }),
    };
    const adapter = createSessionClientAdapter(transport);

    await expect(adapter.page(query)).rejects.toThrow(SessionQueryValidationError);
    await expect(adapter.campaignChildren(campaignRequest)).rejects.toThrow(SessionQueryValidationError);
    await expect(adapter.neighbors(neighborRequest)).rejects.toThrow(SessionQueryValidationError);
  });

  test('preserves unavailable trust semantics and rejects unsafe local responses', async () => {
    const adapter = createSessionClientAdapter(defaultTransport());
    expect(await adapter.detail({ revision: query.revision, rowId: 'row-1' })).toEqual(detailUnavailable);
    expect(await adapter.vcs({ revision: query.revision, rowId: 'row-1' })).toEqual(vcsUnavailable);

    const staleDetail = createSessionClientAdapter({
      ...defaultTransport(),
      detail: () => Promise.resolve({ ...availableDetail, revision: 'revision-2' }),
    });
    await expect(staleDetail.detail({ revision: query.revision, rowId: 'row-1' })).rejects.toThrow(
      SessionDetailValidationError,
    );

    const unsafeVcs = createSessionClientAdapter({
      ...defaultTransport(),
      vcs: () =>
        Promise.resolve({
          pullRequests: [],
          repositoryUrl: 'file:///private/repository',
          status: 'available',
        }),
    });
    await expect(unsafeVcs.vcs({ revision: query.revision, rowId: 'row-1' })).rejects.toThrow();
  });

  test('forwards supersession while keeping the current revision independent', async () => {
    const currentQuery = parseSessionQueryRequest({ ...query, revision: 'revision-2' });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const abortReason = new DOMException('superseded', 'AbortError');
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let invocation = 0;
    const adapter = createSessionClientAdapter({
      ...defaultTransport(),
      page: async (_input, options) => {
        invocation += 1;
        if (invocation === 2) {
          return pageEnvelope(currentQuery);
        }
        firstStarted?.();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
        return pageEnvelope();
      },
    });

    const staleError = adapter.page(query, firstController.signal).catch((error: unknown) => error);
    await firstStartedPromise;
    const current = adapter.page(currentQuery, secondController.signal);
    expect(await current).toEqual(pageEnvelope(currentQuery));
    firstController.abort(abortReason);

    expect(await staleError).toBe(abortReason);
    expect(secondController.signal.aborted).toBe(false);
  });

  test('rejects malformed query envelopes before they reach Session state', async () => {
    const adapter = createSessionClientAdapter({
      ...defaultTransport(),
      page: () => Promise.resolve({ ...pageEnvelope(), privatePath: '/private/store.sqlite' }),
    });
    await expect(adapter.page(query)).rejects.toThrow(SessionQueryValidationError);
  });
});
