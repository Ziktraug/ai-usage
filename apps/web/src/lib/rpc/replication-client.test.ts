import { describe, expect, test } from 'bun:test';
import { createReplicationBrowserAdapter, type ReplicationRpcTransport } from './replication-client';

const status = {
  kind: 'replication-status',
  lastDiagnostic: null,
  memory: null,
  mode: 'local-only',
  runtimeState: 'disabled',
  usage: null,
} as const;

describe('replication status browser adapter', () => {
  test('validates output and forwards the caller signal through RPC', async () => {
    const controller = new AbortController();
    let receivedInput: unknown;
    let receivedSignal: AbortSignal | undefined;
    const adapter = createReplicationBrowserAdapter({
      status: (input, options) => {
        receivedInput = input;
        receivedSignal = options?.signal;
        return Promise.resolve(status);
      },
    });

    expect(await adapter.status(controller.signal)).toEqual(status);
    expect(receivedInput).toEqual({});
    expect(receivedSignal).toBe(controller.signal);

    const malformed = createReplicationBrowserAdapter({
      status: () => Promise.resolve({ ...status, databasePath: '/private/replication.sqlite' } as never),
    } as ReplicationRpcTransport);
    await expect(malformed.status()).rejects.toThrow();
  });
});
