import { getContext, type Snippet, setContext } from 'svelte';

const sourceControlSummaryKey = Symbol('ai-usage-source-control-summary');
type SourceControlSummaryGetter = () => Snippet | undefined;

export const provideSourceControlSummary = (summary: SourceControlSummaryGetter): void => {
  setContext(sourceControlSummaryKey, summary);
};

export const useSourceControlSummary = (): Snippet | undefined => {
  const summary = getContext<SourceControlSummaryGetter | undefined>(sourceControlSummaryKey);
  if (!summary) {
    throw new Error('Source control summary context is unavailable.');
  }
  return summary();
};
