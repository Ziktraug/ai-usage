import { describe, expect, test } from 'bun:test';
import {
  parseSessionDetailRequest,
  parseSessionDetailResponse,
  type SessionDetail,
  SessionDetailValidationError,
} from './session-detail';

const tokens = { cacheRead: 60, cacheWrite: 0, input: 30, output: 10, total: 100 };

const detail: SessionDetail = {
  activeDurationMs: 120_000,
  durationStatus: 'recorded',
  efforts: ['ultra', 'high'],
  elapsedDurationMs: 3_720_000,
  endedAt: '2026-07-18T11:02:00.000Z',
  idleDurationMs: 3_600_000,
  models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  observedAt: '2026-07-18T11:02:01.000Z',
  phases: [
    {
      cost: 1.2,
      costKind: 'approximate',
      effort: 'ultra',
      effortKind: 'recorded',
      endAt: '2026-07-18T10:01:00.000Z',
      model: 'gpt-5.6-sol',
      startAt: '2026-07-18T10:00:00.000Z',
      tokens,
    },
    {
      cost: 0.2,
      costKind: 'approximate',
      effort: 'high',
      effortKind: 'recorded',
      endAt: '2026-07-18T11:02:00.000Z',
      model: 'gpt-5.6-terra',
      startAt: '2026-07-18T11:01:00.000Z',
      tokens,
    },
  ],
  prompts: [
    {
      id: 'prompt-1',
      text: 'Build the report',
      timestamp: '2026-07-18T10:00:00.000Z',
      truncated: false,
    },
  ],
  promptsTruncated: false,
  sourceSessionId: 'session-1',
  startedAt: '2026-07-18T10:00:00.000Z',
  turns: [
    {
      durationMs: 60_000,
      effort: 'ultra',
      effortKind: 'recorded',
      endAt: '2026-07-18T10:01:00.000Z',
      index: 0,
      intervals: [{ endAt: '2026-07-18T10:01:00.000Z', startAt: '2026-07-18T10:00:00.000Z' }],
      model: 'gpt-5.6-sol',
      promptIds: ['prompt-1'],
      startAt: '2026-07-18T10:00:00.000Z',
      tokens,
      tools: 3,
    },
  ],
  turnsStatus: 'recorded',
};

describe('session detail contract', () => {
  test('strictly parses bounded source-identity requests', () => {
    const request = {
      harnessKey: 'codex',
      machineId: 'machine-a',
      sourceSessionId: 'session-1',
    };

    expect(parseSessionDetailRequest(request)).toEqual(request);
    expect(() => parseSessionDetailRequest({ ...request, artifactPath: '/private/history.jsonl' })).toThrow(
      SessionDetailValidationError,
    );
  });

  test('accepts a bounded available detail response', () => {
    expect(parseSessionDetailResponse({ detail, status: 'available' })).toEqual({ detail, status: 'available' });
  });

  test('accepts explicit unavailable states', () => {
    expect(
      parseSessionDetailResponse({
        message: 'Detailed history is only available on the source machine.',
        reason: 'not-local',
        status: 'unavailable',
      }),
    ).toEqual({
      message: 'Detailed history is only available on the source machine.',
      reason: 'not-local',
      status: 'unavailable',
    });
  });

  test('rejects inconsistent tokens, invalid durations, and unknown response keys', () => {
    expect(() =>
      parseSessionDetailResponse({
        detail: {
          ...detail,
          phases: [{ ...detail.phases[0], tokens: { ...tokens, total: 101 } }],
        },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        detail: {
          ...detail,
          turns: [
            {
              ...detail.turns[0],
              intervals: [{ endAt: '2026-07-18T10:01:01.000Z', startAt: '2026-07-18T10:00:00.000Z' }],
            },
          ],
        },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        detail: {
          ...detail,
          phases: [{ ...detail.phases[0], cost: null, costKind: 'reported' }],
        },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        detail: {
          ...detail,
          turns: [{ ...detail.turns[0], effort: null, effortKind: 'recorded' }],
        },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        detail: { ...detail, activeDurationMs: detail.elapsedDurationMs + 1 },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        detail: { ...detail, idleDurationMs: detail.elapsedDurationMs },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        detail: {
          ...detail,
          phases: [{ ...detail.phases[0]!, startAt: '2026-07-18T09:59:59.999Z' }],
        },
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() => parseSessionDetailResponse({ detail, status: 'available', rawPromptPath: '/private' })).toThrow(
      SessionDetailValidationError,
    );
  });
});
