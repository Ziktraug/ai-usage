import { describe, expect, test } from 'bun:test';
import { SessionDetailValidationError } from '@ai-usage/report-core/session-detail';
import { canAnalyzeSession, loadSessionDetail } from './session-detail-client';

const request = { revision: 'revision-a', rowId: 'row-a' };

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
});
