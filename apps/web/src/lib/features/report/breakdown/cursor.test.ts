import { describe, expect, test } from 'bun:test';
import type { CursorCommitAttributionFacet } from '../../../../report-data';
import { summarizeCursorAiPercentage } from './cursor';

const row = (percentage: number | null, lines: number): CursorCommitAttributionFacet =>
  ({
    commitHash: `${String(percentage)}-${String(lines)}`,
    linesAdded: lines,
    linesDeleted: 0,
    v2AiPercentage: percentage,
  }) as CursorCommitAttributionFacet;

describe('P8 Cursor AI attribution', () => {
  test('weights measured commit percentages by changed lines', () => {
    expect(summarizeCursorAiPercentage([row(100, 10), row(0, 30), row(null, 100)])).toEqual({
      measuredCommits: 2,
      percentage: 25,
      totalCommits: 3,
    });
  });

  test('keeps unavailable attribution distinct from zero', () => {
    expect(summarizeCursorAiPercentage([row(null, 20)])).toEqual({
      measuredCommits: 0,
      percentage: null,
      totalCommits: 1,
    });
  });
});
