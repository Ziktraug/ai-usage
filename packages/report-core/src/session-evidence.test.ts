import { expect, test } from 'bun:test';
import { parseSessionEvidenceResponse, type SessionEvidenceResponse } from './session-evidence';

const response: Extract<SessionEvidenceResponse, { status: 'available' }> = {
  status: 'available',
  revision: 'r1',
  evidence: {
    sourceSessionId: 's1',
    coverage: { partial: false, omittedRecords: 0, unattributedRecords: 0 },
    records: [
      {
        id: 'r1',
        at: '2026-11-01T10:00:00.000Z',
        kind: 'response',
        text: 'Recorded text',
        toolName: null,
        callId: null,
        turnIndex: 0,
        promptIds: ['p1'],
        truncated: false,
      },
    ],
  },
};
test('evidence boundary rejects injected paths, unbounded output, and guessed result statuses', () => {
  expect(parseSessionEvidenceResponse(response)).toEqual(response);
  expect(() => parseSessionEvidenceResponse({ ...response, path: '/native/history' })).toThrow();
  expect(() =>
    parseSessionEvidenceResponse({
      ...response,
      evidence: { ...response.evidence, records: [{ ...response.evidence.records[0], text: 'x'.repeat(8001) }] },
    }),
  ).toThrow();
  expect(() =>
    parseSessionEvidenceResponse({
      ...response,
      evidence: { ...response.evidence, records: [{ ...response.evidence.records[0], kind: 'merged-pr' }] },
    }),
  ).toThrow();
});
