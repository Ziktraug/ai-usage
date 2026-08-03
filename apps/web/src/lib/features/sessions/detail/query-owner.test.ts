import { describe, expect, test } from 'bun:test';
import { parseSessionQueryRequest, sessionNeighborFingerprint } from '@ai-usage/report-core/session-query';
import { isCancelledError } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../../../query/client';
import { sessionDetailKey, sessionNeighborsKey, sessionVcsKey } from '../../../query/options/session';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import { createSessionDetailQueryOwner } from './query-owner';

const query = parseSessionQueryRequest({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 25,
  range: { from: null, to: null },
  revision: 'revision-p4',
  sort: [{ desc: true, id: 'date' }],
});

const unused = (): Promise<never> => Promise.reject(new Error('Unexpected Session client call'));
const clientWith = (overrides: Partial<SessionClientAdapter>): SessionClientAdapter => ({
  campaignChildren: unused,
  detail: unused,
  neighbors: unused,
  page: unused,
  vcs: unused,
  ...overrides,
});

describe('P4 exact Session detail query owner', () => {
  test('uses the frozen Q1 neighbor/detail/VCS keys and keeps each operation independent', async () => {
    const client = clientWith({
      detail: () =>
        Promise.resolve({
          message: 'Synthetic history absent',
          reason: 'not-found',
          status: 'unavailable',
        }),
      neighbors: (request) => {
        const requestFingerprint = sessionNeighborFingerprint(request);
        return Promise.resolve({
          data: {
            found: true,
            next: null,
            previous: null,
            requestFingerprint,
            revision: request.query.revision,
          },
          ok: true,
          requestFingerprint,
          revision: request.query.revision,
        });
      },
      vcs: () => Promise.resolve({ reason: 'not-found', status: 'unavailable' }),
    });
    const queryClient = createWebQueryClient();
    const owner = createSessionDetailQueryOwner({ client, queryClient });

    const [neighbors, detail, vcs] = await Promise.all([
      owner.loadNeighbors({ query, rowId: 'row-a' }),
      owner.loadDetail({ revision: query.revision, rowId: 'row-a' }),
      owner.loadVcs({ revision: query.revision, rowId: 'row-a' }),
    ]);

    expect(neighbors).toMatchObject({ found: true, revision: query.revision });
    expect(detail).toMatchObject({ reason: 'not-found', status: 'unavailable' });
    expect(vcs).toEqual({ reason: 'not-found', status: 'unavailable' });
    expect(queryClient.getQueryData(sessionNeighborsKey({ query, rowId: 'row-a' }))).toBeDefined();
    expect(queryClient.getQueryData(sessionDetailKey({ revision: query.revision, rowId: 'row-a' }))).toBeDefined();
    expect(queryClient.getQueryData(sessionVcsKey({ revision: query.revision, rowId: 'row-a' }))).toBeDefined();
    owner.close();
    queryClient.clear();
  });

  test('cancels the exact in-flight detail on reset and never publishes stale completion', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const queryClient = createWebQueryClient();
    const owner = createSessionDetailQueryOwner({
      client: clientWith({
        detail: (_request, signal) => {
          if (!signal) {
            return Promise.reject(new Error('Missing exact Query abort signal'));
          }
          started.resolve(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }),
      queryClient,
    });

    const pending = owner.loadDetail({ revision: query.revision, rowId: 'row-a' }).catch((error: unknown) => error);
    const signal = await started.promise;
    owner.resetDetail();
    const result = await pending;

    expect(signal.aborted).toBe(true);
    expect(isCancelledError(result)).toBe(true);
    expect(queryClient.isFetching()).toBe(0);
    owner.close();
    queryClient.clear();
  });
});
