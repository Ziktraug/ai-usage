import { expect, test } from 'bun:test';
import { buildPractices, practiceDraft, suggestedPractice } from './practices-model';
import type { ExplorationPrompt } from './prompt-exploration';
import type { SemanticFamily } from './semantic-model';

const entry = (id: string, rowId: string, text: string, ordinal: number): ExplorationPrompt => ({
  at: '2026-10-01',
  harness: 'Codex',
  id,
  ordinal,
  partial: false,
  project: 'synthetic',
  rowId,
  sessionId: rowId,
  text,
});
const start = entry('a', 'one', 'review code', 0);
const repeated = entry('b', 'one', 'review code', 2);
const other = entry('c', 'two', 'review code', 0);
const formulation = { entries: [start, repeated, other], id: 'review code', text: 'review code' };
const family: SemanticFamily = { reference: formulation, members: [{ cosine: 1, formulation, lexical: 1 }] };

test('practice categories are explicit editorial vocabulary, with negation kept unresolved', () => {
  expect(suggestedPractice('review code')).toBe('review');
  expect(suggestedPractice('ne corrige pas le code')).toBeNull();
  expect(suggestedPractice('arbitrary novel wording')).toBeNull();
});
test('counts first visible occurrence per session and partitions observed follow-ups without claiming completion', () => {
  const entries = [start, repeated, other, entry('d', 'one', 'fix code', 1)];
  const review = buildPractices([family], entries).find((practice) => practice.id === 'review');
  expect(review?.cases).toHaveLength(2);
  expect(review?.cases.find((candidate) => candidate.start.rowId === 'one')).toMatchObject({
    start: { id: 'a' },
    nextPractice: 'fix',
  });
  expect(review?.cases.find((candidate) => candidate.start.rowId === 'two')).toMatchObject({
    following: [],
    nextPractice: null,
  });
});
test('editable grouping removes the selected family and source IDs remain in an exported draft', () => {
  expect(buildPractices([family], [start, other], new Set(['review:review code']))[0]?.cases).toEqual([]);
  const review = buildPractices([family], [start, other])[0];
  if (!review) {
    throw new Error('Missing review practice');
  }
  expect(practiceDraft(review, 'revision-1', 'Compare context')).toContain('synthetic · 2026-10-01 · one · a');
  expect(practiceDraft(review, 'revision-1', 'Compare context')).toContain('not evidence of success');
});

test('dossier export preserves the filtered selection and explicit exclusions', () => {
  const review = buildPractices([family], [start, other])[0];
  if (!review) {
    throw new Error('Missing review practice');
  }
  const text = practiceDraft(
    { ...review, cases: review.cases.filter((item) => item.start.rowId === 'one') },
    'r1',
    'Inspect source context',
    {
      project: 'synthetic',
      corpusScope: '{"search":"review","range":"all"}',
      omittedFamilies: ['review:another family'],
      comparisonRowIds: ['one'],
    },
  );
  expect(text).toContain('1 distinct sessions');
  expect(text).toContain('review:another family');
  expect(text).toContain('"search":"review"');
  expect(text).toContain('one · a');
  expect(text).not.toContain('two · c');
});
