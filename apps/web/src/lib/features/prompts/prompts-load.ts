import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import { promptCorpusQueryOptions } from '../../query/options/prompts';
import { reportBootstrapQueryOptions } from '../../query/options/report';
import { createReportClient } from '../../rpc/report-client';
import { requireAvailableReportBootstrap } from '../report/core/report-bootstrap';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';
import { promptRequestForUrl } from './prompts-model';
import { syntheticPromptCorpus } from './prompts-synthetic';
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
