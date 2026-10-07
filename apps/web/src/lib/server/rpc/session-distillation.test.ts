import { describe, expect, test } from 'bun:test';
import { MemoryServiceClientError } from '@ai-usage/memory-service/client';
import type { DistillationStatus } from '@ai-usage/web-contract/session-distillation';
import { call, ORPCError } from '@orpc/server';
import { createSessionDistillationRpcRouter } from './session-distillation';

const request = { kind: 'status' as const, selection: { revision: 'report-1', rowId: 'row-1' } };
const empty: DistillationStatus = {
  state: 'not-analyzed',
  latest: null,
  revisions: [],
  revisionsOmitted: 0,
  job: null,
  sourceStatus: 'unchecked',
};

describe('Session distillation RPC reads', () => {
  test('keeps unsupported mode and unreachable service distinct without exposing private diagnostics', async () => {
    for (const reason of [
      'unsupported-mode',
      'service-unavailable',
      'mapping-required',
      'selection-stale',
      'version-incompatible',
      'storage-unavailable',
      'not-found',
      'source-modified',
    ] as const) {
      const router = createSessionDistillationRpcRouter({
        isDemo: async () => false,
        read: () => Promise.reject(new MemoryServiceClientError(reason, '/private/native-history')),
      });
      await expect(
        call(router.browse, {
          kind: 'browse',
          projectId: null,
          since: null,
          until: null,
          query: '',
          cursor: null,
          limit: 20,
        }),
      ).rejects.toMatchObject({ code: 'Unavailable', data: { reason } });
    }
  });
  test('rejects demo before acquiring local Memory or history', async () => {
    let reads = 0;
    const router = createSessionDistillationRpcRouter({
      isDemo: async () => true,
      read: () => {
        reads += 1;
        return Promise.resolve(empty);
      },
    });
    await expect(call(router.status, request)).rejects.toMatchObject({ code: 'ForbiddenDemo' });
    expect(reads).toBe(0);
  });

  test('passes the authorized selection and cancellation without any generation command', async () => {
    const controller = new AbortController();
    const reads: unknown[] = [];
    const router = createSessionDistillationRpcRouter({
      isDemo: async () => false,
      read: (input, signal) => {
        reads.push({ input, signal });
        return Promise.resolve(empty);
      },
    });
    expect(await call(router.status, request, { signal: controller.signal })).toEqual(empty);
    expect(reads).toEqual([{ input: request, signal: controller.signal }]);
  });

  test('sanitizes private diagnostics and malformed output', async () => {
    for (const read of [
      () => Promise.reject(new Error('/private/secret-history.jsonl')),
      async () => ({ ...empty, state: 'invented' }),
    ]) {
      const router = createSessionDistillationRpcRouter({ isDemo: async () => false, read });
      try {
        await call(router.status, request);
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error).toMatchObject({ code: 'Unavailable' });
        expect(String(error)).not.toContain('/private/');
      }
    }
  });
});
