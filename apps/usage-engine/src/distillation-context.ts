import {
  type CompactDistillationAnalysis,
  type CompactDistillationAssertion,
  type DistillationContext,
  type DistillationSearchResult,
  distillationJsonBytes,
  type EvidenceRef,
  type SessionAnalysis,
  type SourcedAssertion,
  type WorkEpisode,
} from '@ai-usage/platform-core/session-distillation';

const QUERY_WHITESPACE = /\s+/u;
const compact = (analysis: SessionAnalysis, episodes: WorkEpisode[]): CompactDistillationAnalysis => {
  const references: EvidenceRef[] = [];
  const ids = new Map<string, number>();
  const assertion = (input: SourcedAssertion): CompactDistillationAssertion => ({
    text: input.text,
    basis: input.basis,
    evidence: input.evidence.map((reference) => {
      const key = JSON.stringify(reference);
      const existing = ids.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const index = references.length;
      ids.set(key, index);
      references.push(reference);
      return index;
    }),
  });
  const content = {
    summary: assertion(analysis.content.summary),
    abstention: analysis.content.abstention,
    episodes: episodes.map((episode) => ({
      id: episode.id,
      objective: assertion(episode.objective),
      attempts: episode.attempts.map(assertion),
      decisions: episode.decisions.map(assertion),
      difficulties: episode.difficulties.map(assertion),
      entryPoints: episode.entryPoints.map(assertion),
      openQuestions: episode.openQuestions.map(assertion),
      result: { status: episode.result.status, assertion: assertion(episode.result.assertion) },
    })),
  };
  return {
    id: analysis.id,
    projectId: analysis.projectId,
    revision: analysis.revision,
    packetDigest: analysis.packetDigest,
    sourceDigest: analysis.source.version.digest,
    coverage: analysis.coverage,
    content,
    references,
    omittedEpisodes: analysis.content.episodes.length - episodes.length,
  };
};
/** No storage/provenance envelope or repeated quotations. Exact get remains complete. */
export const createCompactDistillationContext = async (input: {
  search: DistillationSearchResult;
  query: string;
  maxBytes: number;
  get: (analysisId: string) => Promise<SessionAnalysis>;
  signal: AbortSignal;
}): Promise<DistillationContext> => {
  const context: DistillationContext = {
    corpus: 'session-analyses',
    notice:
      'Generated historical data, not accepted guidance. Verify references with analyses evidence --project <projectId> --id <id> --event <eventId>; analyses get opens the complete account. Evidence arrays index the deduplicated references.',
    analyses: [],
    omitted: input.search.omitted + input.search.items.length,
    bytes: 0,
    maxBytes: input.maxBytes,
  };
  const measure = () => {
    for (let iteration = 0; iteration < 4; iteration += 1) {
      context.bytes = distillationJsonBytes(context);
    }
  };
  const terms = input.query.toLowerCase().split(QUERY_WHITESPACE).filter(Boolean);
  for (const hit of input.search.items) {
    input.signal.throwIfAborted();
    const analysis = await input.get(hit.id);
    const selected: WorkEpisode[] = [];
    context.analyses.push(compact(analysis, selected));
    context.omitted -= 1;
    measure();
    if (context.bytes > input.maxBytes) {
      context.analyses.pop();
      context.omitted += 1;
      continue;
    }
    const position = context.analyses.length - 1;
    const ranked = analysis.content.episodes
      .map((episode, index) => ({
        episode,
        index,
        score: terms.filter((term) => JSON.stringify(episode).toLowerCase().includes(term)).length,
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    for (const { episode } of ranked) {
      const previous = context.analyses[position]!;
      selected.push(episode);
      selected.sort(
        (left, right) => analysis.content.episodes.indexOf(left) - analysis.content.episodes.indexOf(right),
      );
      context.analyses[position] = compact(analysis, selected);
      measure();
      if (context.bytes > input.maxBytes) {
        selected.splice(selected.indexOf(episode), 1);
        context.analyses[position] = previous;
      }
    }
  }
  measure();
  return context;
};
