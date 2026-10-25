import { type CreateQueryResult, createQuery } from '@tanstack/svelte-query';
import { type DelegationSettingsQueryClient, delegationSettingsQueryOptions } from '../../query/options/delegation';
import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
import { createDelegationClient, type DelegationClientResult } from '../../rpc/delegation-client';
import { createDelegationPageClient } from './delegation-client';
import type { DelegationPageClient, DelegationSettingsView } from './delegation-contract';

const unavailableSettings: DelegationSettingsQueryClient = {
  settings: () => Promise.reject(new Error('Delegation settings RPC is unavailable during SSR.')),
};

/**
 * The settings query, hydrated from the server render. The RPC context is read here, during the
 * component's initialisation: a refetch (after a save, on invalidation) runs outside it, where the
 * context can no longer be read, so the client must exist before the first fetch.
 */
export const createHydratedDelegationSettingsQuery = (
  browser: boolean,
): CreateQueryResult<DelegationClientResult<DelegationSettingsView>, Error> => {
  const rpc = browser ? useOptionalWebQueryRpcContext()?.rpc : undefined;
  const client = rpc === undefined ? unavailableSettings : createDelegationClient(rpc.delegation);
  return createQuery(() => delegationSettingsQueryOptions(client, { browser, enabled: browser && rpc !== undefined }));
};

/** The mutations, or `null` while rendering on the server, where nothing can be saved. */
export const createDelegationPageClientForBrowser = (browser: boolean): DelegationPageClient | null => {
  const rpc = browser ? useOptionalWebQueryRpcContext()?.rpc : undefined;
  return rpc === undefined ? null : createDelegationPageClient(createDelegationClient(rpc.delegation));
};
