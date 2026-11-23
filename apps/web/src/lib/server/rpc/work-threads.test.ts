import { describe, expect, test } from 'bun:test';
import type { WorkThreadsDetailOutput, WorkThreadsListOutput } from '@ai-usage/web-contract/work-threads';
import { call } from '@orpc/server';
import { createWorkThreadsRpcRouter } from './work-threads';

const query = { cursor: null, limit: 50, project: null, search: null, tab: 'open' } as const;
const router = (answer: () => Promise<unknown>) =>
  createWorkThreadsRpcRouter({
    command: () => Promise.reject(new Error('command is not part of this test')),
    detail: answer,
    list: answer,
  });

const messageOf = (output: WorkThreadsListOutput | WorkThreadsDetailOutput): string | null =>
  output.ok ? null : output.error.message;

describe('Work threads RPC server reads', () => {
  test('forwards the reader’s own typed failure', async () => {
    const failure = { ok: false, error: { tag: 'NotFound', message: 'This task could not be found.' } } as const;
    expect(await call(router(() => Promise.resolve(failure)).list, query)).toEqual(failure);
  });

  test('tells a broken reader apart from an answer that does not fit the contract', async () => {
    const broken = await call(router(() => Promise.reject(new Error('module failed to load'))).list, query);
    const misfit = await call(router(() => Promise.resolve({ ok: true, data: { unexpected: true } })).detail, {
      threadId: '10000000-0000-4000-8000-000000000001',
    });
    expect(messageOf(broken)).toContain('failed while reading tasks');
    expect(messageOf(misfit)).toContain('does not fit');
    expect(JSON.stringify(broken)).not.toContain('module failed to load');
  });

  test('re-throws cancellation instead of answering a failure', async () => {
    const controller = new AbortController();
    const pending = call(
      router(() => {
        controller.abort();
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }).list,
      query,
      { signal: controller.signal },
    );
    await expect(pending).rejects.toThrow();
  });
});
