import { describe, expect, test } from 'bun:test';
import type { ReplicationStatus } from '@ai-usage/web-contract/replication';
import { createWebQueryClient } from '../client';
import { replicationStatusQueryOptions } from './replication';

const status: ReplicationStatus = {
  kind: 'replication-status',
  lastDiagnostic: null,
  memory: null,
  mode: 'local-only',
  runtimeState: 'disabled',
  usage: null,
};

describe('replication status Query options', () => {
  test('uses one bounded control-plane identity and forwards cancellation', async () => {
    const observedSignals: AbortSignal[] = [];
    const client = createWebQueryClient();
    const options = replicationStatusQueryOptions(
      {
        status: (signal) => {
          if (signal) {
            observedSignals.push(signal);
          }
          return Promise.resolve(status);
        },
      },
      { browser: true, enabled: true },
    );

    await expect(client.fetchQuery(options)).resolves.toEqual(status);
    expect(options).toMatchObject({
      queryKey: ['web', 'control-plane', 'replication', 'status', 'v1'],
      refetchOnMount: true,
      retry: false,
    });
    expect(observedSignals).toHaveLength(1);
  });
});
