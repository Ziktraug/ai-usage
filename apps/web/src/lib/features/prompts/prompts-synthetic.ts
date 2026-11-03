import {
  type PromptCorpusPage,
  type PromptCorpusRequest,
  promptCorpusPosition,
} from '@ai-usage/report-core/prompt-corpus';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
import { campaignMapFixtureRows } from '../../../campaign-map-fixture';
/** Explicit synthetic history for the demo and isolated browser stack. Never substituted for a failed local source. */
export const syntheticPromptCorpus = (request: PromptCorpusRequest): Promise<PromptCorpusPage> => {
  promptCorpusPosition(request);
  const rows = projectSessionPage(campaignMapFixtureRows, {
    ...request.query,
    filters: { fields: {}, harness: [], machine: [], query: '' },
    range: { from: null, to: null },
    pageSize: 3,
  }).items;
  const entries = [
    { text: 'Review the data parser and explain the edge cases.', project: 'Sample app', harness: 'Codex' },
    { text: 'Add a regression test before fixing the parser.', project: 'Sample app', harness: 'Claude' },
    { text: 'Compare the two approaches and keep the failures visible.', project: 'Sample library', harness: 'Codex' },
  ]
    .map((entry, ordinal) => ({
      ...entry,
      id: `demo-prompt-${ordinal}`,
      rowId: rows[ordinal]?.row.rowId ?? `demo-session-${ordinal}`,
      sessionId: `demo-session-${ordinal}`,
      at: '2026-11-01T10:00:00.000Z',
      ordinal: 0,
      partial: false,
      origin: 'human' as const,
    }))
    .filter(
      (entry) =>
        entry.text.toLowerCase().includes(request.search.toLowerCase()) &&
        (!request.projectLabel || entry.project === request.projectLabel) &&
        (!request.query.filters.harness.length || request.query.filters.harness.includes(entry.harness)) &&
        (!request.query.range.from || entry.at >= request.query.range.from) &&
        (!request.query.range.to || entry.at < request.query.range.to),
    );
  return Promise.resolve({
    entries,
    revision: request.query.revision,
    nextCursor: null,
    scannedSessions: 3,
    unavailableSessions: 0,
    partialSessions: 0,
    truncatedPrompts: 0,
  });
};
