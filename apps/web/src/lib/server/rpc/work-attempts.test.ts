import { describe, expect, test } from 'bun:test';
import type { WorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
import { call } from '@orpc/server';
import { createWorkAttemptsRpcRouter, type WorkAttemptsRpcDependencies } from './work-attempts';

const emptyList: WorkAttemptsListOutput = {
  data: { attempts: [], generatedAt: '2026-10-22T10:05:00.000Z', skipped: 0, target: null, truncated: false },
  ok: true,
};

const router = (dependencies: Partial<WorkAttemptsRpcDependencies>) =>
  createWorkAttemptsRpcRouter({
    stop: () => Promise.resolve({ data: { attemptId: 'a', result: 'requested' }, ok: true }),
    list: () => Promise.resolve(emptyList),
    release: () =>
      Promise.resolve({
        data: { attemptId: 'a', evidence: null, pids: [4242], releasedAt: null, result: 'process-found' },
        ok: true,
      }),
    start: () => Promise.resolve({ data: { attemptId: 'a', reused: false, state: 'starting' }, ok: true }),
    ...dependencies,
  });

const startInput = {
  action: 'read-only-review' as const,
  candidateId: 'declared:["m","claude-code","a"]',
  target: { harness: 'claude', sourceSessionId: 's' },
};

describe('Work attempts RPC server adapter', () => {
  test('relays a stop request, rejects invented stop confirmation and hides failures', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    expect(
      await call(
        router({
          stop: (input, signal) => {
            seen.push({ input, signal });
            return Promise.resolve({ data: { attemptId: 'a', result: 'requested' }, ok: true });
          },
        }).stop,
        { attemptId: 'a' },
        { signal: controller.signal },
      ),
    ).toEqual({
      data: { attemptId: 'a', result: 'requested' },
      ok: true,
    });
    expect(seen).toEqual([{ input: { attemptId: 'a' }, signal: controller.signal }]);
    for (const stop of [
      () => Promise.reject(new Error('/private/store.sqlite')),
      () => Promise.resolve({ data: { attemptId: 'a', result: 'all-descendants-stopped' }, ok: true }),
    ]) {
      expect(await call(router({ stop }).stop, { attemptId: 'a' })).toEqual({
        error: { message: 'The stop request did not complete.', tag: 'Unavailable' },
        ok: false,
      });
    }
  });
  test('relays the release answer and turns a failure or a drifting answer into Unavailable', async () => {
    expect(await call(router({}).release, { attemptId: 'a' })).toEqual({
      data: { attemptId: 'a', evidence: null, pids: [4242], releasedAt: null, result: 'process-found' },
      ok: true,
    });
    for (const release of [
      () => Promise.reject(new Error('engine at /private/store.sqlite')),
      () => Promise.resolve({ data: { attemptId: 'a', result: 'killed' }, ok: true }),
    ]) {
      expect(await call(router({ release }).release, { attemptId: 'a' })).toEqual({
        error: { message: 'The release could not be recorded.', tag: 'Unavailable' },
        ok: false,
      });
    }
  });

  test('forwards inputs and cancellation and returns the exact envelopes', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const routes = router({
      list: (input, signal) => {
        seen.push({ input, signal });
        return Promise.resolve(emptyList);
      },
      start: (input, signal) => {
        seen.push({ input, signal });
        return Promise.resolve({
          error: { message: 'add routing.reviewTargets for /x', reason: 'target-not-allowed', tag: 'Refused' },
          ok: false,
        });
      },
    });
    expect(await call(routes.list, { limit: 5 }, { signal: controller.signal })).toEqual(emptyList);
    expect(await call(routes.start, startInput, { signal: controller.signal })).toMatchObject({
      error: { reason: 'target-not-allowed', tag: 'Refused' },
      ok: false,
    });
    expect(seen).toEqual([
      { input: { limit: 5 }, signal: controller.signal },
      { input: startInput, signal: controller.signal },
    ]);
  });

  test('turns failures and schema drift into the unavailable envelope without leaking detail', async () => {
    const privatePath = '/private/usage.sqlite';
    const broken = router({
      list: () => Promise.reject(new Error(`cannot open ${privatePath}`)),
      start: () => Promise.resolve({ data: { attemptId: 'a', reused: false, state: 'starting', pid: 1 }, ok: true }),
    });
    const list = await call(broken.list, {});
    expect(list).toEqual({ error: { message: 'Review attempts are unavailable.', tag: 'Unavailable' }, ok: false });
    expect(JSON.stringify(list)).not.toContain(privatePath);
    expect(await call(broken.start, startInput)).toEqual({
      error: { message: 'The review could not be started.', reason: null, tag: 'Unavailable' },
      ok: false,
    });
  });

  test('rejects malformed inputs at the contract and re-throws cancellation', async () => {
    const routes = router({});
    await expect(call(routes.list, { limit: 0 })).rejects.toThrow();
    await expect(call(routes.start, { ...startInput, action: 'write' } as never)).rejects.toThrow();
    const controller = new AbortController();
    const cancelled = router({
      list: () => {
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
    });
    await expect(call(cancelled.list, {}, { signal: controller.signal })).rejects.toThrow();
  });
});
