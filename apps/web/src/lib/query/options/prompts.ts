import {
  type PromptCorpusPage,
  type PromptCorpusRequest,
  parsePromptCorpusPage,
  parsePromptCorpusRequest,
} from '@ai-usage/report-core/prompt-corpus';
import { infiniteQueryOptions } from '@tanstack/svelte-query';
import { webQueryPolicies } from '../policies';

/** Native files may advance without a publication: one finite-SWR owner for each bounded corpus search. */
export const promptCorpusQueryOptions = (
  client: { prompts: (input: PromptCorpusRequest, options?: { signal?: AbortSignal }) => Promise<PromptCorpusPage> },
  input: PromptCorpusRequest,
  enabled: boolean,
) => {
  const request = parsePromptCorpusRequest(input);
  return infiniteQueryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled,
    queryKey: ['web', 'prompt-corpus', request.query.revision, JSON.stringify({ ...request, cursor: null })],
    initialPageParam: null as string | null,
    getNextPageParam: (last: PromptCorpusPage) => last.nextCursor ?? undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = parsePromptCorpusPage(await client.prompts({ ...request, cursor: pageParam }, { signal }));
      if (result.revision !== request.query.revision) {
        throw new Error('Prompt corpus revision does not match its request');
      }
      return result;
    },
  });
};

export const PROMPT_CORPUS_CLIENT_PAGE_LIMIT = 40;

/** The Query owner controls continuation and the document's retained corpus budget. */
export const continuePromptCorpus = async (query: {
  data: { pages: readonly PromptCorpusPage[] } | undefined;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}): Promise<void> => {
  if (
    query.hasNextPage &&
    !query.isFetchingNextPage &&
    (query.data?.pages.length ?? 0) < PROMPT_CORPUS_CLIENT_PAGE_LIMIT
  ) {
    await query.fetchNextPage();
  }
};
