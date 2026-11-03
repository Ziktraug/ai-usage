import type { RuntimeMode } from '../../runtime-mode';
import { promptRequestForUrl } from '../features/prompts/prompts-model';
import { syntheticPromptCorpus } from '../features/prompts/prompts-synthetic';
import { requireAvailableReportBootstrap } from '../features/report/core/report-bootstrap';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../features/shell/query-load';
import { createReportClient } from '../rpc/report-client';
import type { WebQueryHydrationState } from './client';
import { promptCorpusQueryOptions } from './options/prompts';
import { reportBootstrapQueryOptions } from './options/report';
export interface PromptsPageData {
  mode: RuntimeMode;
  queryState: WebQueryHydrationState;
  revision: string;
}
export const loadPromptsPage = async (options: RouteQueryLoadOptions, mode: RuntimeMode): Promise<PromptsPageData> => {
  let revision = 'synthetic-prompts-v1';
  const queryState = await createAwaitedRouteQueryState(options, async ({ queryClient, rpc }) => {
    if (mode === 'live') {
      revision = requireAvailableReportBootstrap(
        await queryClient.query(reportBootstrapQueryOptions(createReportClient(rpc), { browser: false })),
      ).manifest.revision;
    }
    await queryClient.infiniteQuery(
      promptCorpusQueryOptions(
        mode === 'live' ? rpc.session : { prompts: syntheticPromptCorpus },
        promptRequestForUrl(options.url, revision),
        false,
      ),
    );
  });
  return { mode, revision, queryState };
};
