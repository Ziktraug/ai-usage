import { replicationContract, replicationStatusSchema } from '@ai-usage/web-contract/replication';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface ReplicationRpcDependencies {
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly readStatus: (signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

export const createReplicationRpcRouter = (dependencies: ReplicationRpcDependencies) => {
  const replication = implement(replicationContract);
  return {
    status: replication.status.handler(async ({ errors, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Device replication is unavailable in demo mode.',
        });
      }
      try {
        return parse(replicationStatusSchema, await dependencies.readStatus(signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.Unavailable({
          data: { reason: 'replication-status-unavailable' },
          message: 'Device replication status could not be read safely.',
        });
      }
    }),
  };
};

export type ReplicationRpcRouter = ReturnType<typeof createReplicationRpcRouter>;
