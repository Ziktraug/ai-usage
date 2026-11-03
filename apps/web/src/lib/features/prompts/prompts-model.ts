import { type PromptCorpusRequest, parsePromptCorpusRequest } from '@ai-usage/report-core/prompt-corpus';
export const promptRequestForUrl = (url: URL, revision: string): PromptCorpusRequest => {
  const params = url.searchParams;
  const date = (name: string, end = false): string | null => {
    const value = params.get(name);
    if (!value) {
      return null;
    }
    const time = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(time)) {
      throw new Error('Invalid prompt period');
    }
    return new Date(time + (end ? 86_400_000 : 0)).toISOString();
  };
  return parsePromptCorpusRequest({
    cursor: null,
    includeUndeclared: params.get('includeUndeclared') === '1',
    search: params.get('q') ?? '',
    query: {
      cursor: null,
      filters: {
        fields: params.get('project') ? { project: params.get('project') } : {},
        harness: params.get('harness') ? [params.get('harness')] : [],
        machine: [],
        origin: [],
        query: '',
      },
      pageSize: 12,
      range: { from: date('from'), to: date('to', true) },
      revision,
      sort: [{ id: 'date', desc: true }],
    },
  });
};
