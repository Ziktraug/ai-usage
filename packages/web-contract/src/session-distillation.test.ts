import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import { sessionDistillationContract } from './session-distillation';

const selection = { revision: 'report-1', rowId: 'row-1' };

describe('Session distillation browser contract', () => {
  test('exposes only bounded selection-scoped reads', () => {
    expect(Object.keys(sessionDistillationContract).sort()).toEqual(['evidence', 'get', 'status']);
    for (const [procedure, input] of [
      [sessionDistillationContract.status, { kind: 'status', selection }],
      [sessionDistillationContract.get, { kind: 'get', selection, analysisId: 'analysis-1' }],
      [
        sessionDistillationContract.evidence,
        { kind: 'evidence', selection, analysisId: 'analysis-1', eventIds: ['event-1'] },
      ],
    ] as const) {
      expect(safeParse(procedure['~orpc'].inputSchema!, input).success).toBe(true);
      expect(safeParse(procedure['~orpc'].inputSchema!, { ...input, path: '/private/history.jsonl' }).success).toBe(
        false,
      );
      expect(safeParse(procedure['~orpc'].inputSchema!, { kind: 'prepare', selection }).success).toBe(false);
    }
  });

  test('rejects project authority, additional fields and oversized evidence selection', () => {
    const schema = sessionDistillationContract.get['~orpc'].inputSchema!;
    expect(safeParse(schema, { kind: 'get', projectId: 'project-other', analysisId: 'analysis-1' }).success).toBe(
      false,
    );
    expect(
      safeParse(schema, { kind: 'get', selection: { ...selection, machineId: 'other' }, analysisId: 'analysis-1' })
        .success,
    ).toBe(false);
    expect(
      safeParse(sessionDistillationContract.evidence['~orpc'].inputSchema!, {
        kind: 'evidence',
        selection,
        analysisId: 'analysis-1',
        eventIds: Array.from({ length: 13 }, (_, index) => `event-${index}`),
      }).success,
    ).toBe(false);
  });

  test('rejects accessors without invoking them before runtime parsing', () => {
    let reads = 0;
    const input = {
      kind: 'status',
      get selection() {
        reads += 1;
        return selection;
      },
    };
    expect(safeParse(sessionDistillationContract.status['~orpc'].inputSchema!, input).success).toBe(false);
    expect(reads).toBe(0);
  });
});
