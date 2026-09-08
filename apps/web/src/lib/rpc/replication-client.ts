import {
  parseReplicationStatus,
  type ReplicationContractClient,
  type ReplicationStatus,
} from '@ai-usage/web-contract/replication';

export type ReplicationRpcTransport = Pick<ReplicationContractClient, 'status'>;

export interface ReplicationBrowserAdapter {
  readonly status: (signal?: AbortSignal) => Promise<ReplicationStatus>;
}

export const createReplicationBrowserAdapter = (transport: ReplicationRpcTransport): ReplicationBrowserAdapter => ({
  status: async (signal) => {
    signal?.throwIfAborted();
    const result = await transport.status({}, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseReplicationStatus(result);
  },
});
