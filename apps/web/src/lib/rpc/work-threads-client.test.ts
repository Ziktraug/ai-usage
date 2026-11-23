import { describe, expect, test } from 'bun:test';
import type { WorkThreadsContractClient } from '@ai-usage/web-contract/work-threads';
import { ORPCError } from '@orpc/client';
import { createWorkThreadsClient } from './work-threads-client';

const query = { cursor: null, limit: 50, project: null, search: null, tab: 'open' } as const;
const transport = (answer: () => Promise<unknown>) =>
  createWorkThreadsClient({
    command: () => Promise.reject(new Error('command is not part of this test')),
    detail: answer,
    list: answer,
  } as unknown as WorkThreadsContractClient);

const message = async (answer: () => Promise<unknown>): Promise<string | null> => {
  const result = await transport(answer).list(query);
  return result.ok ? null : result.error.message;
};

describe('Work threads browser client reads', () => {
  test('passes a typed read failure through unchanged', async () => {
    const failure = {
      ok: false,
      error: { tag: 'Unavailable', message: 'The usage store has not been upgraded.' },
    } as const;
    expect(await transport(() => Promise.resolve(failure)).list(query)).toEqual(failure);
    expect(await transport(() => Promise.resolve(failure)).detail({ threadId: 'x' })).toEqual(failure);
  });

  test('names a server that cannot be reached, apart from one that answered an error', async () => {
    const unreachable = await message(() => Promise.reject(new TypeError('Failed to fetch')));
    const crashed = await message(() =>
      Promise.reject(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Internal server error', status: 500 })),
    );
    const defined = await message(() =>
      Promise.reject(
        new ORPCError('Unavailable', { defined: true, message: 'The engine is not running.', status: 503 }),
      ),
    );
    expect(unreachable).toContain('could not be reached');
    expect(crashed).toContain('HTTP 500');
    expect(defined).toBe('The engine is not running.');
  });

  test('names an answer this page cannot read, apart from a transport failure', async () => {
    const result = await message(() => Promise.resolve({ ok: true, data: { unexpected: true } }));
    expect(result).toContain('reload the page');
  });

  test('re-throws cancellation instead of reporting a failure', async () => {
    const controller = new AbortController();
    const pending = transport(() => {
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }).list(query, { signal: controller.signal });
    await expect(pending).rejects.toThrow();
  });
});
