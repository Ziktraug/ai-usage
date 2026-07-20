import { describe, expect, test } from 'bun:test';
import { serializeUsageRow } from './report-data';
import {
  compareSessionProjectionFacts,
  parseSessionDetailAnchorResult,
  parseSessionDetailRequest,
  parseSessionDetailResponse,
  type SessionDetail,
  type SessionDetailComparableField,
  type SessionDetailConsistency,
  SessionDetailValidationError,
  sessionDetailRequestFingerprint,
  sessionProjectionFactsForSerializedRow,
} from './session-detail';
import type { UsageRow } from './types';

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

const fullConsistency: SessionDetailConsistency = {
  checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
  status: 'matches-report',
};

const usageRow: UsageRow = {
  calls: 2,
  costActual: null,
  costApprox: 1.5,
  costKnown: true,
  date: new Date('2026-07-18T10:00:00.000Z'),
  durationMs: 120_000,
  endDate: new Date('2026-07-18T10:02:00.000Z'),
  harness: 'OpenCode',
  linesAdded: null,
  linesDeleted: null,
  model: 'openai/gpt-5',
  modelSegments: [
    {
      costApprox: 1,
      costKnown: true,
      model: 'openai/gpt-5',
      tokCr: 60,
      tokCw: 0,
      tokIn: 30,
      tokOut: 10,
    },
    {
      costApprox: 0.5,
      costKnown: true,
      model: 'anthropic/claude',
      tokCr: 20,
      tokCw: 4,
      tokIn: 15,
      tokOut: 11,
    },
  ],
  models: ['openai/gpt-5', 'anthropic/claude'],
  name: 'Projection fixture',
  partial: true,
  project: 'ai-usage',
  provider: 'OpenAI API',
  tokCr: 80,
  tokCw: 4,
  tokIn: 45,
  tokOut: 21,
  tools: 3,
  turns: 2,
};

describe('session detail contract', () => {
  test('projects validated serialized rows into canonical comparable facts', () => {
    expect(sessionProjectionFactsForSerializedRow(serializeUsageRow(usageRow))).toEqual({
      calls: 2,
      durationMs: 120_000,
      modelSegments: [
        {
          model: 'anthropic/claude',
          tokens: { cacheRead: 20, cacheWrite: 4, input: 15, output: 11, total: 50 },
        },
        {
          model: 'openai/gpt-5',
          tokens: { cacheRead: 60, cacheWrite: 0, input: 30, output: 10, total: 100 },
        },
      ],
      partial: true,
      tokens: { cacheRead: 80, cacheWrite: 4, input: 45, output: 21, total: 150 },
      tools: 3,
      turns: 2,
    });
  });

  test('keeps unavailable usage null and refuses legacy multi-model attribution', () => {
    const { modelSegments: _modelSegments, ...legacyUsageRow } = usageRow;
    const serialized = serializeUsageRow({
      ...legacyUsageRow,
      costApprox: 0,
      costKnown: true,
      usageUnavailable: true,
    });

    expect(sessionProjectionFactsForSerializedRow(serialized)).toMatchObject({
      modelSegments: null,
      tokens: null,
    });
    expect(() => sessionProjectionFactsForSerializedRow({ ...serialized, prompt: 'private' })).toThrow(
      SessionDetailValidationError,
    );
  });
  test('strictly parses bounded exact-revision requests', () => {
    const request = {
      revision: 'revision-a',
      rowId: 'row-a',
    };

    expect(parseSessionDetailRequest(request)).toEqual(request);
    expect(sessionDetailRequestFingerprint(request)).toStartWith('session-detail-v2:');
    expect(() => parseSessionDetailRequest({ ...request, machineId: 'machine-a' })).toThrow(
      SessionDetailValidationError,
    );
  });

  test('strictly parses found, provenance-free, and absent anchors', () => {
    const request = { revision: 'revision-a', rowId: 'row-a' };
    const baseResult = {
      requestFingerprint: sessionDetailRequestFingerprint(request),
      revision: request.revision,
    };
    expect(parseSessionDetailAnchorResult({ ...baseResult, anchor: null }, request).anchor).toBeNull();
    expect(
      parseSessionDetailAnchorResult(
        {
          ...baseResult,
          anchor: {
            harnessKey: null,
            machineId: null,
            projection: sessionProjectionFactsForSerializedRow(serializeUsageRow(usageRow)),
            sourceAuthority: 'portable-opaque',
            sourceSessionId: null,
          },
        },
        request,
      ).anchor,
    ).toMatchObject({
      harnessKey: null,
      machineId: null,
      sourceAuthority: 'portable-opaque',
      sourceSessionId: null,
    });
    expect(() =>
      parseSessionDetailAnchorResult(
        { ...baseResult, requestFingerprint: 'session-detail-v2:wrong', anchor: null },
        request,
      ),
    ).toThrow(SessionDetailValidationError);
  });

  test('compares fields in fixed order across matches and mismatches', () => {
    const projection = sessionProjectionFactsForSerializedRow(serializeUsageRow(usageRow));
    expect(compareSessionProjectionFacts(projection, projection)).toEqual(fullConsistency);
    expect(
      compareSessionProjectionFacts(projection, {
        ...projection,
        calls: 3,
        durationMs: 1,
        modelSegments:
          projection.modelSegments?.map((segment) => ({ ...segment, model: `${segment.model}-changed` })) ?? null,
        partial: false,
        tokens: projection.tokens ? { ...projection.tokens, input: 46, total: 151 } : null,
        tools: 4,
        turns: 3,
      }),
    ).toEqual({
      checkedFields: fullConsistency.checkedFields,
      differingFields: fullConsistency.checkedFields,
      status: 'differs-from-report',
    });
    const mismatches: Array<{ field: SessionDetailComparableField; local: typeof projection }> = [
      { field: 'calls', local: { ...projection, calls: 3 } },
      { field: 'duration', local: { ...projection, durationMs: null } },
      {
        field: 'model-attribution',
        local: {
          ...projection,
          modelSegments:
            projection.modelSegments?.map((segment) => ({ ...segment, model: `${segment.model}-changed` })) ?? null,
        },
      },
      { field: 'coverage', local: { ...projection, partial: false } },
      {
        field: 'tokens',
        local: { ...projection, tokens: projection.tokens ? { ...projection.tokens, input: 46, total: 151 } : null },
      },
      { field: 'tools', local: { ...projection, tools: 4 } },
      { field: 'turns', local: { ...projection, turns: 3 } },
    ];
    for (const mismatch of mismatches) {
      expect(compareSessionProjectionFacts(projection, mismatch.local)).toMatchObject({
        differingFields: [mismatch.field],
        status: 'differs-from-report',
      });
    }
  });

  test('cannot compare two unavailable usages but detects coverage changes', () => {
    const projection = sessionProjectionFactsForSerializedRow(
      serializeUsageRow({ ...usageRow, usageUnavailable: true }),
    );
    expect(compareSessionProjectionFacts(projection, projection)).toEqual({
      checkedFields: ['duration', 'model-attribution', 'coverage', 'turns'],
      reason: 'insufficient-comparable-facts',
      status: 'cannot-compare',
    });
    expect(compareSessionProjectionFacts(projection, { ...projection, tokens })).toMatchObject({
      differingFields: ['coverage'],
      status: 'differs-from-report',
    });
  });

  test('does not invent legacy model attribution or compare costs', () => {
    const { modelSegments: _segments, ...legacyRow } = usageRow;
    const projection = sessionProjectionFactsForSerializedRow(serializeUsageRow(legacyRow));
    expect(projection.modelSegments).toBeNull();
    expect(compareSessionProjectionFacts(projection, projection)).toEqual({
      checkedFields: ['calls', 'duration', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });
    expect(
      compareSessionProjectionFacts(
        sessionProjectionFactsForSerializedRow(serializeUsageRow({ ...legacyRow, costApprox: 1 })),
        sessionProjectionFactsForSerializedRow(serializeUsageRow({ ...legacyRow, costApprox: 999 })),
      ),
    ).toEqual({
      checkedFields: ['calls', 'duration', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });
  });

  test('accepts a bounded available detail response', () => {
    const response = { consistency: fullConsistency, detail, revision: 'revision-a', status: 'available' } as const;
    expect(parseSessionDetailResponse(response)).toEqual(response);
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
        consistency: fullConsistency,
        detail: {
          ...detail,
          phases: [{ ...detail.phases[0], tokens: { ...tokens, total: 101 } }],
        },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: {
          ...detail,
          prompts: [{ ...detail.prompts[0]!, text: 'x'.repeat(32 * 1024 + 1) }],
        },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: {
          ...detail,
          turns: [
            {
              ...detail.turns[0],
              intervals: [{ endAt: '2026-07-18T10:01:01.000Z', startAt: '2026-07-18T10:00:00.000Z' }],
            },
          ],
        },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: {
          ...detail,
          phases: [{ ...detail.phases[0], cost: null, costKind: 'reported' }],
        },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: {
          ...detail,
          turns: [{ ...detail.turns[0], effort: null, effortKind: 'recorded' }],
        },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: { ...detail, activeDurationMs: detail.elapsedDurationMs + 1 },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: { ...detail, idleDurationMs: detail.elapsedDurationMs },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail: {
          ...detail,
          phases: [{ ...detail.phases[0]!, startAt: '2026-07-18T09:59:59.999Z' }],
        },
        revision: 'revision-a',
        status: 'available',
      }),
    ).toThrow(SessionDetailValidationError);
    expect(() =>
      parseSessionDetailResponse({
        consistency: fullConsistency,
        detail,
        revision: 'revision-a',
        status: 'available',
        rawPromptPath: '/private',
      }),
    ).toThrow(SessionDetailValidationError);
  });
});
