import type { ReplicationStatus } from '@ai-usage/web-contract/replication';
import { type CreateQueryResult, createQuery } from '@tanstack/svelte-query';
import { type ReplicationStatusClient, replicationStatusQueryOptions } from '../../query/options/replication';
import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
import { createReplicationBrowserAdapter } from '../../rpc/replication-client';

const unavailableStatus = (): Promise<never> =>
  Promise.reject(new Error('Replication status RPC is unavailable during SSR.'));

const createLazyReplicationClient = (): ReplicationStatusClient => {
  let client: ReplicationStatusClient | undefined;
  return {
    status: async (...parameters) => {
      client ??= createReplicationBrowserAdapter(useWebQueryRpcContext().rpc.replication);
      return await client.status(...parameters);
    },
  };
};

export const createReplicationStatusQuery = (browser: boolean): CreateQueryResult<ReplicationStatus, Error> =>
  createQuery(() =>
    replicationStatusQueryOptions(browser ? createLazyReplicationClient() : { status: unavailableStatus }, {
      browser,
      enabled: true,
    }),
  );
