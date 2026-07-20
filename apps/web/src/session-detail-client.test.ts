import { describe, expect, test } from 'bun:test';
import { type SessionDetailResponse, SessionDetailValidationError } from '@ai-usage/report-core/session-detail';
import { canAnalyzeSession, loadSessionDetail } from './session-detail-client';

const request = { revision: 'revision-a', rowId: 'row-a' };
const availableResponse = {
  consistency: { checkedFields: ['tokens'], status: 'matches-report' },
  detail: {
    activeDurationMs: null,
    durationStatus: 'unavailable',
    efforts: [],
    elapsedDurationMs: 60_000,
    endedAt: '2026-07-18T10:01:00.000Z',
    idleDurationMs: null,
    models: [],
    observedAt: '2026-07-18T10:01:01.000Z',
    phases: [],
    prompts: [],
    promptsTruncated: false,
    sourceSessionId: 'session-a',
    startedAt: '2026-07-18T10:00:00.000Z',
    turns: [],
    turnsStatus: 'recorded',
  },
  revision: request.revision,
  status: 'available',
} satisfies SessionDetailResponse;

describe('session detail client', () => {
  test('sends only exact revision and row identity', async () => {
    const requests: unknown[] = [];
    await loadSessionDetail(request, {
      getDetail: (input) => {
        requests.push(input);
        return Promise.resolve({
          message: 'The local rollout is gone.',
          reason: 'not-found',
          status: 'unavailable',
        });
      },
    });
    expect(requests).toEqual([request]);
    expect(JSON.stringify(requests)).not.toContain('machine');
    expect(JSON.stringify(requests)).not.toContain('sourceSession');
    expect(JSON.stringify(requests)).not.toContain('path');
  });

  test('requires a served revision before analysis is offered', () => {
    expect(canAnalyzeSession(request)).toBe(true);
    expect(canAnalyzeSession({ revision: null, rowId: request.rowId })).toBe(false);
    expect(canAnalyzeSession({ revision: '', rowId: request.rowId })).toBe(false);
  });

  test('rejects malformed server responses', async () => {
    await expect(
      loadSessionDetail(request, {
        getDetail: () => Promise.resolve({ detail: {}, status: 'available' }),
      }),
    ).rejects.toThrow(SessionDetailValidationError);
  });

  test('rejects an available detail from a different report revision', async () => {
    await expect(
      loadSessionDetail(request, {
        getDetail: () => Promise.resolve({ ...availableResponse, revision: 'revision-b' }),
      }),
    ).rejects.toThrow('Session detail response does not match its requested revision');
  });
});
