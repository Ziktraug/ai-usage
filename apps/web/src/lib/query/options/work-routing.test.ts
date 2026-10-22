import { describe, expect, test } from 'bun:test';
import type { WorkRoutingClientResult } from '../../rpc/work-routing-client';
import { createWebQueryClient } from '../client';
import { workRoutingContextQueryOptions } from './work-routing';

const result: WorkRoutingClientResult = {
  data: {
    configPath: null,
    declarationErrors: [],
    declarations: [],
    executorObservations: [],
    generatedAt: '2026-10-21T21:05:00.000Z',
    machineId: null,
    observationRead: { skipped: 0, truncated: false },
  },
  ok: true,
};

describe('Work routing context Query options', () => {
  test('uses one finite-swr identity, forwards cancellation and keeps a failure as data', async () => {
    const observedSignals: AbortSignal[] = [];
    const client = createWebQueryClient();
    const options = workRoutingContextQueryOptions(
      {
        getContext: ({ signal } = {}) => {
          if (signal) {
            observedSignals.push(signal);
          }
          return Promise.resolve(result);
        },
      },
      { browser: true, enabled: true },
    );
    await expect(client.fetchQuery(options)).resolves.toEqual(result);
    expect(options).toMatchObject({
      enabled: true,
      queryKey: ['web', 'finite-swr', 'work-routing', 'context'],
      refetchOnMount: true,
      retry: false,
    });
    expect(observedSignals).toHaveLength(1);
    expect(
      workRoutingContextQueryOptions({ getContext: () => Promise.resolve(result) }, { browser: false, enabled: true })
        .enabled,
    ).toBe(false);
  });
});
