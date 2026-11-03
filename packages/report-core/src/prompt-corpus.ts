import { parseSessionQueryRequest, type SessionQueryRequest, sessionQueryFingerprint } from './session-query';

export const PROMPT_CORPUS_LIMITS = { sessions: 12, entries: 100, text: 2000, search: 200 } as const;
export interface PromptCorpusEntry {
  at: string;
  harness: string;
  id: string;
  ordinal: number;
  /** Missing means the harness did not declare human origin. Never inferred from the text. */
  origin?: 'human';
  partial: boolean;
  project: string;
  rowId: string;
  sessionId: string;
  text: string;
}
export interface PromptCorpusRequest {
  cursor: string | null;
  includeUndeclared: boolean;
  /** Exact displayed project label, distinct from query.filters.fields.project identity keys. */
  projectLabel?: string;
  query: SessionQueryRequest;
  search: string;
}
export interface PromptCorpusPage {
  entries: PromptCorpusEntry[];
  nextCursor: string | null;
  partialSessions: number;
  revision: string;
  scannedSessions: number;
  truncatedPrompts: number;
  unavailableSessions: number;
}
export class PromptCorpusValidationError extends Error {}
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new PromptCorpusValidationError('Invalid prompt corpus object');
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) {
    throw new PromptCorpusValidationError('Invalid prompt corpus text');
  }
  return value;
};
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new PromptCorpusValidationError('Invalid prompt corpus count');
  }
  return value;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw new PromptCorpusValidationError('Invalid prompt corpus flag');
  }
  return value;
};
export const parsePromptCorpusRequest = (input: unknown): PromptCorpusRequest => {
  const value = object(input, ['query', 'cursor', 'search', 'includeUndeclared', 'projectLabel']);
  const query = parseSessionQueryRequest(value.query);
  if (query.cursor !== null) {
    throw new PromptCorpusValidationError('Use the corpus continuation, not a session cursor');
  }
  if (query.pageSize > PROMPT_CORPUS_LIMITS.sessions) {
    throw new PromptCorpusValidationError('Prompt reads are limited to twelve sessions per request');
  }
  return {
    query,
    ...(value.projectLabel === undefined ? {} : { projectLabel: text(value.projectLabel, 512).trim() }),
    cursor: value.cursor === null ? null : text(value.cursor, 4096),
    search: text(value.search, PROMPT_CORPUS_LIMITS.search).trim(),
    includeUndeclared: flag(value.includeUndeclared),
  };
};
export const parsePromptCorpusPage = (input: unknown): PromptCorpusPage => {
  const value = object(input, [
    'entries',
    'nextCursor',
    'revision',
    'scannedSessions',
    'unavailableSessions',
    'partialSessions',
    'truncatedPrompts',
  ]);
  if (!Array.isArray(value.entries) || value.entries.length > PROMPT_CORPUS_LIMITS.entries) {
    throw new PromptCorpusValidationError('Invalid prompt page size');
  }
  const entries = value.entries.map((item): PromptCorpusEntry => {
    const entry = object(item, [
      'id',
      'rowId',
      'sessionId',
      'project',
      'harness',
      'at',
      'text',
      'origin',
      'ordinal',
      'partial',
    ]);
    if (entry.origin !== undefined && entry.origin !== 'human') {
      throw new PromptCorpusValidationError('Invalid declared prompt origin');
    }
    const at = text(entry.at, 40);
    if (!Number.isFinite(Date.parse(at))) {
      throw new PromptCorpusValidationError('Invalid prompt date');
    }
    return {
      id: text(entry.id, 1024),
      rowId: text(entry.rowId, 1024),
      sessionId: text(entry.sessionId, 1024),
      project: text(entry.project, 1024),
      harness: text(entry.harness, 128),
      at,
      text: text(entry.text, PROMPT_CORPUS_LIMITS.text),
      ...(entry.origin === 'human' ? { origin: 'human' as const } : {}),
      ordinal: count(entry.ordinal),
      partial: flag(entry.partial),
    };
  });
  return {
    entries,
    nextCursor: value.nextCursor === null ? null : text(value.nextCursor, 4096),
    revision: text(value.revision, 512),
    scannedSessions: count(value.scannedSessions, PROMPT_CORPUS_LIMITS.sessions),
    unavailableSessions: count(value.unavailableSessions, PROMPT_CORPUS_LIMITS.sessions),
    partialSessions: count(value.partialSessions, PROMPT_CORPUS_LIMITS.sessions),
    truncatedPrompts: count(value.truncatedPrompts),
  };
};

export interface PromptCorpusPosition {
  prompt: number;
  row: number;
  sessionCursor: string | null;
}
const corpusIdentity = (request: PromptCorpusRequest): string =>
  JSON.stringify([
    sessionQueryFingerprint(request.query),
    request.search,
    request.includeUndeclared,
    request.projectLabel ?? '',
  ]);
export const promptCorpusCursor = (request: PromptCorpusRequest, position: PromptCorpusPosition): string =>
  `pc1.${encodeURIComponent(JSON.stringify({ ...position, identity: corpusIdentity(request) }))}`;
export const promptCorpusPosition = (request: PromptCorpusRequest): PromptCorpusPosition => {
  if (request.cursor === null) {
    return { sessionCursor: null, row: 0, prompt: 0 };
  }
  if (!request.cursor.startsWith('pc1.')) {
    throw new PromptCorpusValidationError('Invalid corpus continuation');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(request.cursor.slice(4)));
  } catch {
    throw new PromptCorpusValidationError('Invalid corpus continuation');
  }
  const value = object(decoded, ['sessionCursor', 'row', 'prompt', 'identity']);
  if (value.identity !== corpusIdentity(request)) {
    throw new PromptCorpusValidationError('Corpus continuation belongs to another search');
  }
  const sessionCursor = value.sessionCursor === null ? null : text(value.sessionCursor, 4096);
  parseSessionQueryRequest({ ...request.query, cursor: sessionCursor, range: { from: null, to: null } });
  return {
    sessionCursor,
    row: count(value.row, PROMPT_CORPUS_LIMITS.sessions - 1),
    prompt: count(value.prompt, 100_000),
  };
};

export class PromptCorpusRevisionExpiredError extends Error {
  constructor() {
    super('This prompt corpus revision has expired. Reload to read the current publication.');
    this.name = 'PromptCorpusRevisionExpiredError';
  }
}
