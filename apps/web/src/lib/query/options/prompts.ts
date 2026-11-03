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
