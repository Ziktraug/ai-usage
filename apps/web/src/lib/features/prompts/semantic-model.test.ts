import { expect, test } from 'bun:test';
import type { ExplorationPrompt } from './prompt-exploration';
import {
  compatibleFormulations,
  cosineSimilarity,
  groupSemanticFamilies,
  lexicalSimilarity,
  SEMANTIC_MODEL,
} from './semantic-model';

const vector = (a: number, b: number): number[] => [a, b, ...Array.from({ length: 382 }, () => 0)];
const formulation = (text: string, sessionId: string) => ({
  id: text,
  text,
  entries: [{ id: text, rowId: sessionId } as ExplorationPrompt],
});

test('semantic grouping rejects missing, invalid and zero vectors rather than falling back to words', () => {
  expect(() => cosineSimilarity([0], [0])).toThrow();
  expect(() => cosineSimilarity([Number.NaN], [1])).toThrow();
  expect(() => groupSemanticFamilies([formulation('review code', 'one')], [])).toThrow();
  expect(() => groupSemanticFamilies([formulation('review code', 'one')], [[1]])).toThrow();
});

test('groups inspectable paraphrases only against their direct reference, without chaining', () => {
  const formulations = [
    formulation('review code', 'one'),
    formulation('relire code', 'two'),
    formulation('audit code', 'three'),
  ];
  const vectors = [vector(1, 0), vector(0.9, Math.sqrt(0.19)), vector(0.65, Math.sqrt(1 - 0.65 ** 2))];
  const groups = groupSemanticFamilies(formulations, vectors);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.members.map((member) => member.formulation.text)).toEqual(['review code', 'relire code']);
  expect(groups[0]?.members[1]?.cosine).toBeGreaterThan(SEMANTIC_MODEL.threshold);
});

test('keeps negation and different recognized actions apart even if embeddings agree', () => {
  expect(compatibleFormulations('review the code', 'do not review the code')).toBe(false);
  expect(compatibleFormulations('review the code', 'fix the code')).toBe(false);
  expect(
    groupSemanticFamilies(
      [formulation('review code', 'one'), formulation('fix code', 'two')],
      [vector(1, 0), vector(1, 0)],
    ),
  ).toEqual([]);
});

test('lexical and semantic scores have explicit different definitions', () => {
  expect(lexicalSimilarity('review code', 'review code')).toBe(1);
  expect(lexicalSimilarity('review code', 'relire code')).toBeLessThan(0.5);
  expect(cosineSimilarity(vector(1, 0), vector(1, 0))).toBe(1);
});
