import { describe, expect, test } from 'bun:test';
import type { WorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
import { ORPCError } from '@orpc/client';
import { createWorkAttemptsClient, type WorkAttemptsRpcTransport } from './work-attempts-client';

const listOutput: WorkAttemptsListOutput = {
  data: { attempts: [], generatedAt: '2026-10-22T10:05:00.000Z', skipped: 0, target: null, truncated: false },
  ok: true,
};
const startInput = {
  action: 'read-only-review' as const,
  candidateId: 'declared:["m","claude-code","a"]',
  target: { harness: 'claude', sourceSessionId: 's' },
};

describe('Work attempts browser client', () => {
  test('validates both envelopes and forwards inputs and the caller signal', async () => {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const client = createWorkAttemptsClient({
      list: (input, options) => {
        calls.push(['list', input, options?.signal]);
        return Promise.resolve(listOutput);
      },
      start: (input, options) => {
        calls.push(['start', input, options?.signal]);
        return Promise.resolve({ data: { attemptId: 'a', reused: true, state: 'running' }, ok: true });
      },
    });
    expect(await client.list({ limit: 20 }, { signal: controller.signal })).toEqual(listOutput);
    expect(await client.start(startInput, { signal: controller.signal })).toEqual({
      data: { attemptId: 'a', reused: true, state: 'running' },
      ok: true,
    });
    expect(calls).toEqual([
      ['list', { limit: 20 }, controller.signal],
      ['start', startInput, controller.signal],
    ]);
  });

  test('keeps the demo tag, maps everything else to unavailable and never leaks a server detail', async () => {
    const demo = createWorkAttemptsClient({
      list: () => Promise.reject(new ORPCError('ForbiddenDemo', { defined: true, message: 'Demo mode.', status: 403 })),
      start: () =>
        Promise.reject(new ORPCError('ForbiddenDemo', { defined: true, message: 'Demo mode.', status: 403 })),
    });
    expect(await demo.list({})).toEqual({ error: { message: 'Demo mode.', tag: 'ForbiddenDemo' }, ok: false });
    expect(await demo.start(startInput)).toEqual({
      error: { message: 'Demo mode.', reason: null, tag: 'ForbiddenDemo' },
      ok: false,
    });
    const privatePath = '/private/store.sqlite';
    const malformed = createWorkAttemptsClient({
      list: () => Promise.resolve({ ...listOutput, data: { ...listOutput.data, databasePath: privatePath } } as never),
      start: () => Promise.reject(new Error(`engine at ${privatePath}`)),
    } as WorkAttemptsRpcTransport);
    const list = await malformed.list({});
    expect(list.ok).toBe(false);
    expect(JSON.stringify(list)).not.toContain(privatePath);
    expect(await malformed.start(startInput)).toMatchObject({ error: { reason: null, tag: 'Unavailable' }, ok: false });
  });

  test('re-throws cancellation instead of reporting it as unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createWorkAttemptsClient({
      list: () => Promise.resolve(listOutput),
      start: () => Promise.resolve({ data: { attemptId: 'a', reused: false, state: 'starting' }, ok: true }),
    });
    await expect(client.list({}, { signal: controller.signal })).rejects.toThrow();
    await expect(client.start(startInput, { signal: controller.signal })).rejects.toThrow();
  });
});
