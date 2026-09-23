import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';

const tokens = { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 };
const complete = { omittedCount: 0, reasons: [], status: 'complete' as const };
const timestamp = (index: number) => new Date(Date.UTC(2026, 7, 17, 10, index)).toISOString();

export const sessionDetailFixtureResponse = (revision: string, rowId: string): SessionDetailResponse => ({
  consistency: { checkedFields: ['tokens'], status: 'matches-report' },
  revision,
  status: 'available',
  detail: {
    activeDurationMs: null,
    children: [],
    coverage: {
      childDiscovery: complete,
      grouping: complete,
      interactionAttribution: complete,
      promptBodies: complete,
      recordedTiming: complete,
    },
    durationStatus: 'unavailable',
    efforts: [],
    elapsedDurationMs: 3_600_000,
    endedAt: timestamp(60),
    idleDurationMs: null,
    interactions: [],
    models: ['gpt-5.4'],
    observedAt: timestamp(60),
    phases: [],
    prompts: Array.from({ length: 40 }, (_, index) => ({
      id: `${rowId}-prompt-${index}`,
      text: `Round ${index + 1}: ${'Read the session carefully. '.repeat(80)}`,
      timestamp: timestamp(index),
      truncated: false,
    })),
    promptsTruncated: false,
    sourceSessionId: rowId,
    startedAt: timestamp(0),
    turns: Array.from({ length: 40 }, (_, index) => ({
      calls: 1,
      cost: 0.5,
      costKind: 'approximate',
      durationMs: null,
      effort: null,
      effortKind: 'unavailable',
      endAt: timestamp(index + 1),
      index,
      intervals: [],
      model: 'gpt-5.4',
      promptIds: [`${rowId}-prompt-${index}`],
      startAt: timestamp(index),
      timingStatus: 'unavailable',
      tokens,
      tools: 1,
    })),
    turnsStatus: 'recorded',
  },
});
