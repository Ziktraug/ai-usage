import { describe, expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import { createReplicationRpcRouter, type ReplicationRpcDependencies } from './replication';

const localOnlyStatus = {
  kind: 'replication-status',
  lastDiagnostic: null,
  memory: null,
  mode: 'local-only',
  runtimeState: 'disabled',
  usage: null,
} as const;

const replicationRouter = (dependencies: Partial<ReplicationRpcDependencies>) =>
  createReplicationRpcRouter({
    isDemo: () => Promise.resolve(false),
    readStatus: () => Promise.resolve(localOnlyStatus),
    ...dependencies,
  });

const catchError = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail.');
};

describe('replication status RPC server adapter', () => {
  test('returns the exact bounded status and forwards cancellation', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const router = replicationRouter({
      readStatus: (signal) => {
        receivedSignal = signal;
        return Promise.resolve(localOnlyStatus);
      },
    });

    expect(await call(router.status, {}, { signal: controller.signal })).toEqual(localOnlyStatus);
    expect(receivedSignal).toBe(controller.signal);
  });

  test('rejects demo mode before touching the engine', async () => {
    let reads = 0;
    const router = replicationRouter({
      isDemo: () => Promise.resolve(true),
      readStatus: () => {
        reads += 1;
        return Promise.resolve(localOnlyStatus);
      },
    });
    const error = await catchError(call(router.status, {}));

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('ForbiddenDemo');
    expect(reads).toBe(0);
  });

  test('sanitizes malformed or failed engine output', async () => {
    const privatePath = '/private/replication.sqlite';
    for (const readStatus of [
      () => Promise.resolve({ ...localOnlyStatus, databasePath: privatePath }),
      () => Promise.reject(new Error(privatePath)),
    ]) {
      const error = await catchError(call(replicationRouter({ readStatus }).status, {}));
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe('Unavailable');
      expect((error as Error).message).not.toContain(privatePath);
    }
  });
});
