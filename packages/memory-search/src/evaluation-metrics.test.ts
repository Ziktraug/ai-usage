import { describe, expect, test } from 'bun:test';
import { activeMemorySearchEvaluationCases } from './evaluation';
import { summarizeMemorySearchEvaluation } from './evaluation-metrics';

describe('Memory search evaluation metrics', () => {
  test('records the lexical miss without opening the pgvector gate above recall 0.8', () => {
    const observations = activeMemorySearchEvaluationCases.map((evaluationCase, index) => ({
      caseId: evaluationCase.id,
      durationMs: index + 1,
      responseBytes: 100 + index,
      returnedIds:
        evaluationCase.noAnswer || evaluationCase.class === 'semantic-paraphrase'
          ? []
          : [evaluationCase.expectedIds[0]].filter((id) => id !== undefined),
    }));
    const report = summarizeMemorySearchEvaluation({
      adapter: 'synthetic',
      authorizationNoLeakPassed: true,
      cases: activeMemorySearchEvaluationCases,
      observations,
    });

    expect(report.aggregate).toMatchObject({
      caseCount: 11,
      falsePositiveRate: 0,
      meanReciprocalRank: 0.888_889,
      recallAt1: 0.888_889,
      recallAt10: 0.888_889,
    });
    expect(report.vectorGate).toEqual({
      failures: ['semantic-fact-publication'],
      failuresAreSemanticParaphrases: true,
      lexicalRecallAt10: 0.888_889,
      shouldAddPgvector: false,
    });
  });

  test('rejects forbidden results instead of counting them as ordinary false positives', () => {
    const forbidden = activeMemorySearchEvaluationCases[0]?.forbiddenIds[0];
    if (!forbidden) {
      throw new Error('The authorization-negative fixture is missing.');
    }
    expect(() =>
      summarizeMemorySearchEvaluation({
        adapter: 'unsafe',
        authorizationNoLeakPassed: false,
        cases: activeMemorySearchEvaluationCases,
        observations: activeMemorySearchEvaluationCases.map((evaluationCase) => ({
          caseId: evaluationCase.id,
          durationMs: 1,
          responseBytes: 1,
          returnedIds: [forbidden],
        })),
      }),
    ).toThrow('Memory search evaluation observation is invalid');
  });
});
