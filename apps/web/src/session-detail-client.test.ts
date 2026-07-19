import { describe, expect, test } from 'bun:test';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { canAnalyzeSession, loadSessionDetail, sessionDetailRequestForRow } from './session-detail-client';

const row = {
  harness: 'Codex',
  source: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    sourceSessionId: 'session-a',
  },
} as SessionPresentationRow;

describe('session detail client', () => {
  test('builds a bounded request only from row provenance', () => {
    expect(sessionDetailRequestForRow(row)).toEqual({
      harnessKey: 'codex',
      machineId: 'machine-a',
      sourceSessionId: 'session-a',
    });
    expect(canAnalyzeSession(row)).toBe(true);
    expect(canAnalyzeSession({ ...row, source: { ...row.source!, harnessKey: 'opencode' } })).toBe(true);
  });

  test('returns explicit unavailable states without calling the server', async () => {
    let calls = 0;
    const response = await loadSessionDetail(
      { ...row, source: { ...row.source!, harnessKey: 'claude' } },
      {
        getDetail: () => {
          calls += 1;
          return Promise.resolve(null);
        },
      },
    );

    expect(response).toMatchObject({ reason: 'unsupported', status: 'unavailable' });
    expect(calls).toBe(0);
  });

  test('validates the server response', async () => {
    const response = await loadSessionDetail(row, {
      getDetail: () =>
        Promise.resolve({
          message: 'The local rollout is gone.',
          reason: 'not-found',
          status: 'unavailable',
        }),
    });

    expect(response).toEqual({
      message: 'The local rollout is gone.',
      reason: 'not-found',
      status: 'unavailable',
    });
  });
});
