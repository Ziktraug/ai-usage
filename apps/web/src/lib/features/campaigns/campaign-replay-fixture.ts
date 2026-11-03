import { completeCoverage, type SessionDetailResponse } from '@ai-usage/report-core/session-detail';

const at = (minute: number) => new Date(Date.UTC(2026, 5, 11, 8, minute)).toISOString();

/** Native-shaped records exclusively for the isolated synthetic forecast campaign. */
export const campaignReplayFixture = (revision: string): SessionDetailResponse => ({
  status: 'available',
  revision,
  consistency: { checkedFields: [], status: 'cannot-compare', reason: 'insufficient-comparable-facts' },
  detail: {
    sourceSessionId: 'forecast-root',
    observedAt: at(80),
    startedAt: at(0),
    endedAt: at(80),
    elapsedDurationMs: 4_800_000,
    activeDurationMs: null,
    idleDurationMs: null,
    durationStatus: 'unavailable',
    efforts: [],
    models: ['gpt-5.3-codex'],
    phases: [],
    coverage: {
      childDiscovery: completeCoverage(),
      grouping: completeCoverage(),
      promptBodies: completeCoverage(),
      interactionAttribution: completeCoverage(),
      recordedTiming: { status: 'unavailable', omittedCount: null, reasons: ['timing-not-recorded'] },
    },
    children: [
      {
        sourceSessionId: 'forecast-model',
        evidence: 'codex-thread-edge',
        spawnTurnIndex: null,
        label: 'Define the data model',
        agentType: null,
      },
    ],
    interactions: [
      {
        at: at(5),
        kind: 'message',
        label: 'Review the recorded data model',
        toolUseId: 'fixture-message',
        childSourceSessionId: 'forecast-model',
        turnIndex: 0,
      },
    ],
    promptsTruncated: false,
    prompts: [
      {
        id: 'forecast-plan',
        timestamp: at(0),
        text: 'Plan the forecast model using the recorded inputs.',
        truncated: false,
      },
      {
        id: 'forecast-review',
        timestamp: at(50),
        text: 'Review the forecast changes and report the remaining checks.',
        truncated: false,
      },
    ],
    turnsStatus: 'recorded',
    turns: [0, 50].map((minute, index) => ({
      index,
      startAt: at(minute),
      endAt: at(index ? 80 : 45),
      promptIds: [index ? 'forecast-review' : 'forecast-plan'],
      model: 'gpt-5.3-codex',
      effort: null,
      effortKind: 'unavailable',
      intervals: [],
      timingStatus: 'unavailable',
      durationMs: null,
      calls: 1,
      tools: 1,
      cost: null,
      costKind: 'unknown',
      tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, total: 125 },
    })),
  },
});
