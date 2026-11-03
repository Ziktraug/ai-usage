import {
  PROMPT_CORPUS_LIMITS,
  type PromptCorpusPage,
  type PromptCorpusRequest,
  PromptCorpusRevisionExpiredError,
  parsePromptCorpusPage,
  parsePromptCorpusRequest,
  promptCorpusCursor,
  promptCorpusPosition,
} from '@ai-usage/report-core/prompt-corpus';
import type { SessionDetailRequest, SessionDetailResponse } from '@ai-usage/report-core/session-detail';
import type {
  SessionPageResult,
  SessionQueryRequest,
  SessionQueryServerResult,
} from '@ai-usage/report-core/session-query';
import { runRevisionQueryForServer } from './revision-query-runner.server';
import { getLocalSessionDetailForServer } from './session-detail.server';

export interface PromptCorpusDependencies {
  readDetail: (request: SessionDetailRequest, signal?: AbortSignal) => Promise<SessionDetailResponse>;
  readPage: (query: SessionQueryRequest, signal?: AbortSignal) => Promise<SessionQueryServerResult<SessionPageResult>>;
}
const defaults: PromptCorpusDependencies = {
  readPage: (query, signal) =>
    runRevisionQueryForServer('sessions', query, undefined, signal === undefined ? {} : { signal }),
  readDetail: (request, signal) =>
    getLocalSessionDetailForServer(request, undefined, signal === undefined ? {} : { signal }),
};
/** Bounded native-history scan. Continuation includes the prompt offset, including when a single session exceeds the result budget. */
export const readPromptCorpusForServer = async (
  input: PromptCorpusRequest,
  dependencies = defaults,
  signal?: AbortSignal,
): Promise<PromptCorpusPage> => {
  const request = parsePromptCorpusRequest(input);
  const position = promptCorpusPosition(request);
  signal?.throwIfAborted();
  // The selected period applies to interventions, not the session's birth date.
  const page = await dependencies.readPage(
    { ...request.query, cursor: position.sessionCursor, range: { from: null, to: null } },
    signal,
  );
  if (!page.ok) {
    if (page.error.tag === 'RevisionExpired') {
      throw new PromptCorpusRevisionExpiredError();
    }
    throw new Error(page.error.message);
  }
  const result: PromptCorpusPage = {
    entries: [],
    nextCursor:
      page.data.nextCursor === null
        ? null
        : promptCorpusCursor(request, { sessionCursor: page.data.nextCursor, row: 0, prompt: 0 }),
    revision: request.query.revision,
    scannedSessions: 0,
    unavailableSessions: 0,
    partialSessions: 0,
    truncatedPrompts: 0,
  };
  const search = request.search.toLocaleLowerCase();
  for (let rowIndex = position.row; rowIndex < page.data.items.length; rowIndex++) {
    signal?.throwIfAborted();
    const row = page.data.items[rowIndex]?.row;
    if (!row) {
      continue;
    }
    result.scannedSessions++;
    if (row.origin !== 'human' && !(request.includeUndeclared && row.origin === undefined)) {
      continue;
    }
    const response = await dependencies.readDetail({ revision: request.query.revision, rowId: row.rowId }, signal);
    signal?.throwIfAborted();
    if (response.status !== 'available') {
      result.unavailableSessions++;
      continue;
    }
    const detail = response.detail;
    const partial = detail.promptsTruncated || detail.coverage.promptBodies.status !== 'complete';
    if (partial) {
      result.partialSessions++;
    }
    const start = rowIndex === position.row ? position.prompt : 0;
    for (let ordinal = start; ordinal < detail.prompts.length; ordinal++) {
      const prompt = detail.prompts[ordinal];
      if (!prompt) {
        continue;
      }
      if (request.query.range.from !== null && prompt.timestamp < request.query.range.from) {
        continue;
      }
      if (request.query.range.to !== null && prompt.timestamp >= request.query.range.to) {
        continue;
      }
      if (!prompt.text.toLocaleLowerCase().includes(search)) {
        continue;
      }
      if (result.entries.length >= PROMPT_CORPUS_LIMITS.entries) {
        result.nextCursor = promptCorpusCursor(request, {
          sessionCursor: position.sessionCursor,
          row: rowIndex,
          prompt: ordinal,
        });
        return parsePromptCorpusPage(result);
      }
      const truncated = prompt.truncated || prompt.text.length > PROMPT_CORPUS_LIMITS.text;
      if (truncated) {
        result.truncatedPrompts++;
      }
      const matchAt = search ? prompt.text.toLocaleLowerCase().indexOf(search) : 0;
      const excerptStart = Math.max(0, matchAt - 200);
      result.entries.push({
        id: `${row.rowId}:${prompt.id}`,
        rowId: row.rowId,
        sessionId: detail.sourceSessionId,
        project: row.projectLabel,
        harness: row.sortHarness,
        at: prompt.timestamp,
        text: prompt.text.slice(excerptStart, excerptStart + PROMPT_CORPUS_LIMITS.text),
        ...(row.origin === 'human' ? { origin: 'human' } : {}),
        ordinal,
        partial: partial || truncated,
      });
    }
  }
  return parsePromptCorpusPage(result);
};
