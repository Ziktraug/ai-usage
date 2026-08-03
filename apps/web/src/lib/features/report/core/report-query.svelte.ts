import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { type CreateQueryResult, createQuery } from '@tanstack/svelte-query';
import { type ReportQueryClient, reportBootstrapQueryOptions } from '../../../query/options/report';
import { createBrowserWebRpcClient } from '../../../rpc/client';
import { createReportClient } from '../../../rpc/report-client';

const unavailableCall = (): Promise<never> => Promise.reject(new Error('Report RPC is unavailable during SSR.'));

const createServerPlaceholderClient = (): ReportQueryClient => ({
  getFocusedReportBreakdown: unavailableCall,
  getFocusedReportOverview: unavailableCall,
  getFocusedReportSupport: unavailableCall,
  getReportRevisionBootstrap: unavailableCall,
  getReportRevisionManifest: unavailableCall,
});

const createLazyBrowserClient = (): ReportQueryClient => {
  let client: ReportQueryClient | undefined;
  const getClient = (): ReportQueryClient => {
    client ??= createReportClient(createBrowserWebRpcClient('svelte-report-bootstrap'));
    return client;
  };
  return {
    getFocusedReportBreakdown: async (...parameters) => await getClient().getFocusedReportBreakdown(...parameters),
    getFocusedReportOverview: async (...parameters) => await getClient().getFocusedReportOverview(...parameters),
    getFocusedReportSupport: async (...parameters) => await getClient().getFocusedReportSupport(...parameters),
    getReportRevisionBootstrap: async (...parameters) => await getClient().getReportRevisionBootstrap(...parameters),
    getReportRevisionManifest: async (...parameters) => await getClient().getReportRevisionManifest(...parameters),
  };
};

/** Uses the exact current-alias options hydrated by loadReportPageData. */
export const createHydratedReportBootstrapQuery = (
  enabled: () => boolean,
): CreateQueryResult<ReportRevisionBootstrapResult, Error> => {
  const client =
    typeof globalThis.location === 'undefined' ? createServerPlaceholderClient() : createLazyBrowserClient();
  return createQuery(() => reportBootstrapQueryOptions(client, { browser: enabled() }));
};
