import { describe, expect, test } from 'bun:test';
import { type SessionDetailResponse, SessionDetailValidationError } from '@ai-usage/report-core/session-detail';
import { SessionDetailValidationError as RequestValidationError } from '@ai-usage/report-core/session-detail-request';
import {
  parseSessionQueryRequest,
  SessionQueryValidationError,
  sessionCampaignChildrenFingerprint,
  sessionLookupFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { classifySessionAnalysisError } from '../../session-analysis-error';
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
const lookupRequest = { revision: query.revision, rowId: 'row-1' };
const lookupEnvelope = () => ({
  data: {
    found: false,
    requestFingerprint: sessionLookupFingerprint(lookupRequest),
    revision: query.revision,
    row: null,
  },
  ok: true as const,
  requestFingerprint: sessionLookupFingerprint(lookupRequest),
  revision: query.revision,
});
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
      root: null,
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
    children: [],
    coverage: {
      childDiscovery: { omittedCount: 0, reasons: [], status: 'complete' },
      grouping: { omittedCount: 0, reasons: [], status: 'complete' },
      interactionAttribution: { omittedCount: 0, reasons: [], status: 'complete' },
      promptBodies: { omittedCount: 0, reasons: [], status: 'complete' },
      recordedTiming: { omittedCount: 0, reasons: [], status: 'complete' },
    },
    durationStatus: 'unavailable',
    efforts: [],
    elapsedDurationMs: 60_000,
    endedAt: '2026-07-18T10:01:00.000Z',
    idleDurationMs: null,
    interactions: [],
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
  lookup: () => Promise.resolve(lookupEnvelope()),
  neighbors: () => Promise.resolve(neighborEnvelope()),
  page: () => Promise.resolve(pageEnvelope()),
  vcs: () => Promise.resolve(vcsUnavailable),
});

describe('Session RPC browser adapter', () => {
  test('validates the detail response lazily with the same terminal error identity', async () => {
    const adapter = createSessionClientAdapter({
      ...defaultTransport(),
      detail: () =>
        Promise.resolve({
          ...availableDetail,
          detail: {
            ...availableDetail.detail,
            coverage: {
              ...availableDetail.detail.coverage,
              childDiscovery: { omittedCount: -1, reasons: [], status: 'complete' },
            },
          },
        }),
    });
    const error = await adapter.detail({ revision: query.revision, rowId: 'row-1' }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SessionDetailValidationError);
    expect(error).toBeInstanceOf(RequestValidationError);
    expect(classifySessionAnalysisError(error)).toMatchObject({ kind: 'terminal' });
  });

  test('rejects invalid detail identities before transport and keeps cancellation during lazy validation', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const adapter = createSessionClientAdapter({
      ...defaultTransport(),
      detail: (_input, options) => {
        const signal = options?.signal;
        if (!signal) {
          throw new Error('Expected the original cancellation signal');
        }
        started.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    await expect(adapter.detail({ revision: query.revision, rowId: '' })).rejects.toThrow(RequestValidationError);
    const controller = new AbortController();
    const pending = adapter
      .detail({ revision: query.revision, rowId: 'row-1' }, controller.signal)
      .catch((error: unknown) => error);
    expect(await started.promise).toBe(controller.signal);
    const reason = new DOMException('Detail closed', 'AbortError');
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

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
      lookup: (input, options) => {
        calls.push({ input, name: 'lookup', signal: options?.signal });
        return Promise.resolve(lookupEnvelope());
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

  test('canonicalizes lookup requests and rejects stale lookup envelopes', async () => {
    const seen: unknown[] = [];
    const adapter = createSessionClientAdapter({
      ...defaultTransport(),
      lookup: (input) => {
        seen.push(input);
        return Promise.resolve(lookupEnvelope());
      },
    });
    expect(await adapter.lookup({ revision: query.revision, rowId: 'row-1' })).toEqual(lookupEnvelope());
    await expect(adapter.lookup({ revision: query.revision, rowId: ' row-1 ' })).rejects.toThrow(
      SessionQueryValidationError,
    );
    expect(seen).toEqual([lookupRequest]);

    const stale = createSessionClientAdapter({
      ...defaultTransport(),
      lookup: () => Promise.resolve({ ...lookupEnvelope(), revision: 'stale-revision' }),
    });
    await expect(stale.lookup(lookupRequest)).rejects.toThrow(SessionQueryValidationError);
  });
});
