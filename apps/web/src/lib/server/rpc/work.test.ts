import { describe, expect, test } from 'bun:test';
import type { WorkAttentionDatasetWire } from '@ai-usage/web-contract/work';
import { call } from '@orpc/server';
import { createWorkRpcRouter } from './work';

const AT = '2026-10-20T12:00:00.000Z';

const dataset: WorkAttentionDatasetWire = {
  coverage: {
    checkouts: { failed: 0, lastRunAt: null, observed: 0 },
    codexSessions: { campaignsInWindow: 0, campaignsRead: 0 },
    jira: { disabled: false, failed: 0, lastRunAt: null, observed: 0, reason: null },
    desktopSessions: {
      collectedAt: AT,
      filesParsed: 0,
      filesSeen: 0,
      refusedRows: 0,
      sessionsRead: 0,
      sessionsStored: 0,
      truncated: false,
      unsupported: 0,
    },
    pullRequests: { disabled: true, failed: 0, lastRunAt: null, observed: 0 },
    sessions: { joined: 0, revision: null, unmatched: 0 },
    window: { excludedRoots: 0, sinceDays: 30 },
  },
  generatedAt: AT,
  machineId: 'machine-a',
  roots: [],
  totalRoots: 0,
  truncated: false,
};

describe('work rpc router', () => {
  test('passes the input through and returns the validated envelope', async () => {
    const inputs: unknown[] = [];
    const router = createWorkRpcRouter({
      readAttention: (input) => {
        inputs.push(input);
        return Promise.resolve({ data: dataset, ok: true });
      },
    });
    const result = await call(router.attention, { limit: 25, machineId: 'machine-a' }, { context: {} });
    expect(result).toEqual({ data: dataset, ok: true });
    expect(inputs).toEqual([{ limit: 25, machineId: 'machine-a' }]);
  });

  test('relays a failure envelope untouched', async () => {
    const router = createWorkRpcRouter({
      readAttention: () =>
        Promise.resolve({
          error: { message: 'Work attention is unavailable in demo mode.', tag: 'ForbiddenDemo' },
          ok: false,
        }),
    });
    expect(await call(router.attention, {}, { context: {} })).toEqual({
      error: { message: 'Work attention is unavailable in demo mode.', tag: 'ForbiddenDemo' },
      ok: false,
    });
  });

  test('answers unavailable when the dependency throws or returns a shape outside the contract', async () => {
    const throwing = createWorkRpcRouter({ readAttention: () => Promise.reject(new Error('/private/path leaked')) });
    const thrown = await call(throwing.attention, {}, { context: {} });
    expect(thrown).toEqual({ error: { message: 'Work attention is unavailable.', tag: 'Unavailable' }, ok: false });
    expect(JSON.stringify(thrown)).not.toContain('/private');

    const malformed = createWorkRpcRouter({
      readAttention: () => Promise.resolve({ data: { ...dataset, roots: [{ bogus: true }] }, ok: true }),
    });
    expect(await call(malformed.attention, {}, { context: {} })).toEqual({
      error: { message: 'Work attention is unavailable.', tag: 'Unavailable' },
      ok: false,
    });
  });

  test('rejects an input outside the contract before reaching the dependency', async () => {
    let reached = false;
    const router = createWorkRpcRouter({
      readAttention: () => {
        reached = true;
        return Promise.resolve({ data: dataset, ok: true });
      },
    });
    await expect(call(router.attention, { limit: 0 } as never, { context: {} })).rejects.toThrow();
    await expect(call(router.attention, { sinceDays: 1 } as never, { context: {} })).rejects.toThrow();
    expect(reached).toBe(false);
  });
});
