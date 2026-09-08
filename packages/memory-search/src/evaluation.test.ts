import { describe, expect, test } from 'bun:test';
import {
  activeMemorySearchEvaluationCases,
  memorySearchEvaluationCases,
  memorySearchEvaluationDocuments,
} from './evaluation';

const permissionFixturePattern = /^(authorized|forbidden)-person$/u;

describe('Memory search evaluation corpus', () => {
  test('pins every required query class before ranking implementation', () => {
    expect(new Set(memorySearchEvaluationCases.map((entry) => entry.class))).toEqual(
      new Set([
        'authorization-negative',
        'exact-command',
        'exact-identifier',
        'history',
        'multilingual',
        'no-answer',
        'prompt-injection',
        'scope-precedence',
        'semantic-paraphrase',
        'trust',
        'typo-fuzzy',
        'work-handoff',
      ]),
    );
    expect(memorySearchEvaluationCases.find((entry) => entry.class === 'work-handoff')?.activation).toBe('plan-108');
  });

  test('records expected, alternative, forbidden, permission, and no-answer expectations', () => {
    const documentIds = new Set(memorySearchEvaluationDocuments.map((entry) => entry.id));
    for (const evaluationCase of memorySearchEvaluationCases) {
      expect(evaluationCase.permissionFixture).toMatch(permissionFixturePattern);
      expect(
        [
          ...evaluationCase.expectedIds,
          ...evaluationCase.acceptableAlternativeIds,
          ...evaluationCase.forbiddenIds,
        ].every((id) => documentIds.has(id)),
      ).toBe(true);
      expect(evaluationCase.noAnswer).toBe(evaluationCase.expectedIds.length === 0);
    }
  });

  test('keeps active fixtures synthetic, multilingual, and authorization-negative', () => {
    expect(activeMemorySearchEvaluationCases.length).toBeGreaterThanOrEqual(10);
    expect(
      memorySearchEvaluationDocuments.some((entry) => entry.spaceId !== memorySearchEvaluationDocuments[0]?.spaceId),
    ).toBe(true);
    expect(
      memorySearchEvaluationDocuments.some((entry) => entry.title.includes('français')) &&
        memorySearchEvaluationDocuments.some((entry) => entry.title.includes('ranking')),
    ).toBe(true);
  });
});
