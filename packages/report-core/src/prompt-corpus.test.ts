import { expect, test } from 'bun:test';
import { parsePromptCorpusPage, parsePromptCorpusRequest } from './prompt-corpus';

const query = {
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 12,
  range: { from: null, to: null },
  revision: 'r1',
  sort: [{ id: 'date', desc: true }],
};
test('corpus rejects unbounded history reads and undeclared fields', () => {
  expect(parsePromptCorpusRequest({ query, cursor: null, search: 'review', includeUndeclared: false }).search).toBe(
    'review',
  );
  expect(() =>
    parsePromptCorpusRequest({ query: { ...query, pageSize: 13 }, cursor: null, search: '', includeUndeclared: false }),
  ).toThrow();
  expect(() =>
    parsePromptCorpusRequest({ query, cursor: null, search: '', includeUndeclared: false, path: '/private' }),
  ).toThrow();
});
test('corpus preserves unknown provenance and bounded continuation', () => {
  const entry = {
    id: 'p',
    rowId: 'r',
    sessionId: 's',
    project: 'project',
    harness: 'Codex',
    at: '2026-01-01T00:00:00.000Z',
    text: 'Review this change',
    ordinal: 0,
    partial: false,
  };
  const page = {
    entries: [entry],
    revision: 'r1',
    nextCursor: 'next',
    scannedSessions: 12,
    unavailableSessions: 1,
    partialSessions: 2,
    truncatedPrompts: 0,
  };
  expect(parsePromptCorpusPage(page).entries[0]?.origin).toBeUndefined();
  expect(() => parsePromptCorpusPage({ ...page, entries: [{ ...entry, origin: 'human-inferred' }] })).toThrow();
  expect(() => parsePromptCorpusPage({ ...page, entries: [{ ...entry, text: 'x'.repeat(2001) }] })).toThrow();
});
