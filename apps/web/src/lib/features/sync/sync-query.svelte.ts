import type { SyncFleet } from '@ai-usage/web-contract/sync';
import { type CreateQueryResult, createQuery } from '@tanstack/svelte-query';
import { type SyncFleetClient, syncFleetQueryOptions } from '../../query/options/sync';
import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
import { createSyncBrowserAdapter } from '../../rpc/sync-client';

const unavailableFleet = (): Promise<never> => Promise.reject(new Error('Sync RPC is unavailable during SSR.'));

const createLazySyncClient = (): SyncFleetClient => {
  let client: SyncFleetClient | undefined;
  const getClient = (): SyncFleetClient => {
    client ??= createSyncBrowserAdapter(useWebQueryRpcContext().rpc.sync);
    return client;
  };
  return { fleet: async (...parameters) => await getClient().fleet(...parameters) };
};

export const createHydratedSyncFleetQuery = (
  browser: boolean,
  compatibleGeneration: () => string,
): CreateQueryResult<SyncFleet, Error> => {
  const client = browser ? createLazySyncClient() : { fleet: unavailableFleet };
  return createQuery(() =>
    syncFleetQueryOptions(client, {
      browser,
      compatibleGeneration: compatibleGeneration(),
      enabled: true,
    }),
  );
};
