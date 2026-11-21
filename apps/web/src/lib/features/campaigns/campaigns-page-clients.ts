import type { WebContractClient } from '@ai-usage/web-contract';
import { createReportClient } from '../../rpc/report-client';
import { createSessionClientAdapter } from '../../rpc/session-client';
import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
import type { CampaignsPageData } from './campaigns-load';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

/**
 * The page's report and session clients: the browser RPC adapters, named placeholders while rendering
 * on the server or without an RPC context, and the synthetic session client outside live mode.
 */
export const campaignPageClientsFor = (input: {
  readonly browser: boolean;
  readonly mode: CampaignsPageData['mode'];
  readonly rpc: WebContractClient | undefined;
}) => {
  const { browser, mode, rpc } = input;
  const report =
    browser && rpc
      ? createReportClient(rpc)
      : ssrUnavailableClient<ReturnType<typeof createReportClient>>('campaigns report');
  if (mode !== 'live') {
    return { report, session: createSyntheticCampaignClient() };
  }
  const session =
    browser && rpc
      ? createSessionClientAdapter(rpc.session)
      : ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('campaigns session');
  return { report, session };
};
