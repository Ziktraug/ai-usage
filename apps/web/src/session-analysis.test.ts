import { describe, expect, test } from 'bun:test';
import type {
  SessionDetail,
  SessionDetailPhase,
  SessionDetailPrompt,
  SessionDetailTurn,
} from '@ai-usage/report-core/session-detail';
import {
  buildSessionTimelineRows,
  buildTimelineScale,
  countActivityBursts,
  countLabel,
  formatSessionDuration,
  GAP_COMPRESSION_THRESHOLD_MS,
  phaseTokenShare,
  positionOnScale,
  positionOnTimeline,
  sessionDurationCaption,
  sessionDurationSemantics,
  timelineHasCompressibleGaps,
} from './session-analysis-model';

const tokens = (total: number) => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: total,
  output: 0,
  total,
});

const phase = (total: number, startAt = '2026-07-18T10:00:00.000Z'): SessionDetailPhase => ({
  cost: 1,
  costKind: 'approximate',
  effort: 'high',
  effortKind: 'recorded',
  endAt: '2026-07-18T11:00:00.000Z',
  model: 'gpt-5.6-sol',
  startAt,
  tokens: tokens(total),
});

const turn = (
  index: number,
  startAt: string,
  endAt: string,
  overrides: Partial<SessionDetailTurn> = {},
): SessionDetailTurn => ({
  durationMs: Date.parse(endAt) - Date.parse(startAt),
  effort: 'high',
  effortKind: 'recorded',
  endAt,
  index,
  intervals: [{ endAt, startAt }],
  model: 'gpt-5.6-sol',
  promptIds: [],
  startAt,
  timingStatus: 'recorded',
  tokens: tokens(10),
  tools: 0,
  ...overrides,
});

const prompt = (id: string, timestamp: string): SessionDetailPrompt => ({
  id,
  text: `Prompt ${id}`,
  timestamp,
  truncated: false,
});

const detail = (overrides: Partial<SessionDetail> = {}): SessionDetail => ({
  activeDurationMs: 30 * 60_000,
  durationStatus: 'recorded',
  efforts: ['high'],
  elapsedDurationMs: 60 * 60_000,
  endedAt: '2026-07-18T11:00:00.000Z',
  idleDurationMs: 30 * 60_000,
  models: ['gpt-5.6-sol'],
  observedAt: '2026-07-18T11:00:00.000Z',
  phases: [],
  prompts: [],
  promptsTruncated: false,
  sourceSessionId: 'session-1',
  startedAt: '2026-07-18T10:00:00.000Z',
  turns: [],
  turnsStatus: 'recorded',
  ...overrides,
});

describe('session analysis model', () => {
  test('positions every band on the same elapsed-time axis', () => {
    expect(
      positionOnTimeline(
        '2026-07-18T10:15:00.000Z',
        '2026-07-18T10:45:00.000Z',
        '2026-07-18T10:00:00.000Z',
        '2026-07-18T11:00:00.000Z',
      ),
    ).toEqual({ leftPercent: 25, widthPercent: 50 });
  });

  test('clips out-of-range bands without changing the shared axis', () => {
    expect(
      positionOnTimeline(
        '2026-07-18T09:45:00.000Z',
        '2026-07-18T10:15:00.000Z',
        '2026-07-18T10:00:00.000Z',
        '2026-07-18T11:00:00.000Z',
      ),
    ).toEqual({ leftPercent: 0, widthPercent: 25 });
  });

  test('uses token totals, not phase duration, for phase shares', () => {
    const phases = [phase(300), phase(100, '2026-07-18T11:00:00.000Z')];

    expect(phaseTokenShare(phases[0]!, phases)).toBe(75);
    expect(phaseTokenShare(phases[1]!, phases)).toBe(25);
    expect(phaseTokenShare(phase(0), [phase(0), phase(0)])).toBe(0);
  });

  test('merges overlapping and touching turns into active bursts', () => {
    const turns = [
      turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:10:00.000Z'),
      turn(1, '2026-07-18T10:08:00.000Z', '2026-07-18T10:15:00.000Z'),
      turn(2, '2026-07-18T10:15:00.000Z', '2026-07-18T10:20:00.000Z'),
      turn(3, '2026-07-18T12:00:00.000Z', '2026-07-18T12:05:00.000Z'),
    ];

    expect(countActivityBursts(turns)).toBe(2);
    expect(countActivityBursts([])).toBe(0);
  });

  test('preserves pauses between activity segments inside one logical turn', () => {
    const groupedTurn = {
      ...turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:30:00.000Z'),
      intervals: [
        { endAt: '2026-07-18T10:05:00.000Z', startAt: '2026-07-18T10:00:00.000Z' },
        { endAt: '2026-07-18T10:30:00.000Z', startAt: '2026-07-18T10:25:00.000Z' },
      ],
    };

    expect(countActivityBursts([groupedTurn])).toBe(2);
  });

  test('formats session durations without hiding idle gaps behind decimals', () => {
    expect(formatSessionDuration(8 * 3_600_000 + 37 * 60_000)).toBe('8h 37m');
    expect(formatSessionDuration(45_000)).toBe('45s');
    expect(formatSessionDuration(0)).toBe('0s');
  });

  test('labels harness intervals without claiming model runtime', () => {
    expect(sessionDurationSemantics('codex')).toMatchObject({
      burstLabel: 'Task blocks',
      elapsedLabel: 'Session span',
      gapLabel: 'Between tasks',
      metricLabel: 'Task-open time',
      rowNoun: 'Task',
      timelineHeading: 'Task timeline',
    });
    expect(sessionDurationSemantics('codex').metricHint).toContain('not model runtime');
    expect(sessionDurationSemantics('opencode')).toMatchObject({
      gapLabel: 'Outside assistant',
      metricLabel: 'Assistant time',
      rowNoun: 'Turn',
      timelineHeading: 'Assistant timeline',
    });
    expect(sessionDurationSemantics('claude')).toMatchObject({
      gapLabel: 'Unattributed span',
      metricLabel: 'Recorded turn time',
      rowNoun: 'Turn',
    });
    expect(sessionDurationSemantics('codex', true)).toMatchObject({
      metricLabel: 'Root task-open time',
      rowNoun: 'Task',
    });
    expect(sessionDurationSemantics('codex', true).metricHint).toContain('root session only');
  });

  test('builds duration captions from each harness semantics and coverage status', () => {
    const harnesses = [
      { harnessKey: 'codex', labels: ['Task-open time', 'Session span', 'Between tasks', 'Task blocks'] },
      { harnessKey: 'opencode', labels: ['Assistant time', 'Session span', 'Outside assistant', 'Assistant bursts'] },
      {
        harnessKey: 'claude',
        labels: ['Recorded turn time', 'Session span', 'Unattributed span', 'Recorded turn blocks'],
      },
    ];

    for (const { harnessKey, labels } of harnesses) {
      const semantics = sessionDurationSemantics(harnessKey);
      for (const durationStatus of ['recorded', 'partial'] as const) {
        const parts = sessionDurationCaption(detail({ durationStatus }), semantics, 3);
        const partial = durationStatus === 'partial';

        expect(parts.map(({ key }) => key)).toEqual(['active', 'span', 'gap', 'blocks']);
        expect(parts.map(({ label }) => label)).toEqual(labels);
        expect(parts.map(({ value }) => value)).toEqual(['30m', '1h', '30m', '3']);
        expect(parts.map(({ bound }) => bound)).toEqual([
          partial ? 'lower' : null,
          null,
          partial ? 'upper' : null,
          null,
        ]);
        expect(parts.map(({ hint }) => hint)).toEqual([
          semantics.metricHint,
          semantics.elapsedHint,
          semantics.gapHint,
          semantics.burstHint,
        ]);
      }
    }
  });

  test('renders unavailable timing as span-only and keeps untimed turns as points', () => {
    const unavailable = detail({
      activeDurationMs: null,
      durationStatus: 'unavailable',
      idleDurationMs: null,
      turns: [
        turn(0, '2026-07-18T10:10:00.000Z', '2026-07-18T10:10:00.000Z', {
          durationMs: null,
          intervals: [],
          timingStatus: 'unavailable',
        }),
      ],
    });

    expect(sessionDurationCaption(unavailable, sessionDurationSemantics('claude'), 0)).toEqual([
      expect.objectContaining({ key: 'span', value: '1h' }),
    ]);
    expect(buildSessionTimelineRows(unavailable)).toMatchObject([{ durationMs: null, intervals: [], kind: 'task' }]);
    expect(timelineHasCompressibleGaps(unavailable)).toBe(false);
  });

  test('pluralizes simple count labels', () => {
    expect(countLabel(1, 'prompt')).toBe('1 prompt');
    expect(countLabel(2, 'prompt')).toBe('2 prompts');
    expect(countLabel(0, 'tool')).toBe('0 tools');
  });

  test('joins nominal task prompts in chronological task order', () => {
    const rows = buildSessionTimelineRows(
      detail({
        prompts: [prompt('late', '2026-07-18T10:31:00.000Z'), prompt('early', '2026-07-18T10:01:00.000Z')],
        turns: [
          turn(1, '2026-07-18T10:30:00.000Z', '2026-07-18T10:40:00.000Z', { promptIds: ['late'] }),
          turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:10:00.000Z', { promptIds: ['early'] }),
        ],
      }),
    );

    expect(rows.map((row) => (row.kind === 'task' ? row.prompts[0]?.id : 'orphan'))).toEqual(['early', 'late']);
  });

  test('joins each prompt to its first chronological task and sorts unified rows', () => {
    const earlyTurn = turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:10:00.000Z', {
      promptIds: ['p1', 'shared'],
      tokens: tokens(100),
    });
    const lateTurn = turn(1, '2026-07-18T10:30:00.000Z', '2026-07-18T10:40:00.000Z', {
      promptIds: ['p2', 'shared', 'missing'],
      tokens: tokens(200),
    });
    const noPromptTurn = turn(2, '2026-07-18T10:50:00.000Z', '2026-07-18T11:00:00.000Z', {
      tokens: tokens(50),
    });
    const rows = buildSessionTimelineRows(
      detail({
        prompts: [
          prompt('p2', '2026-07-18T10:31:00.000Z'),
          prompt('orphan', '2026-07-18T10:20:00.000Z'),
          prompt('shared', '2026-07-18T10:02:00.000Z'),
          prompt('p1', '2026-07-18T10:01:00.000Z'),
        ],
        turns: [lateTurn, noPromptTurn, earlyTurn],
      }),
    );

    expect(rows.map((row) => (row.kind === 'task' ? `task-${row.index}` : row.prompt.id))).toEqual([
      'task-0',
      'orphan',
      'task-1',
      'task-2',
    ]);
    const taskRows = rows.filter((row) => row.kind === 'task');
    expect(taskRows.map((row) => row.prompts.map(({ id }) => id))).toEqual([['p1', 'shared'], ['p2'], []]);
    expect(taskRows.map(({ tokenShareOfMax }) => tokenShareOfMax)).toEqual([0.5, 1, 0.25]);
    expect(taskRows.every(({ tokenShareOfMax }) => Number.isFinite(tokenShareOfMax))).toBe(true);
  });

  test('keeps zero-token task shares finite', () => {
    const rows = buildSessionTimelineRows(
      detail({
        turns: [
          turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:10:00.000Z', { tokens: tokens(0) }),
          turn(1, '2026-07-18T10:20:00.000Z', '2026-07-18T10:30:00.000Z', { tokens: tokens(0) }),
        ],
      }),
    );

    const shares = rows.flatMap((row) => (row.kind === 'task' ? [row.tokenShareOfMax] : []));
    expect(shares).toEqual([0, 0]);
    expect(shares.every((share) => Number.isFinite(share))).toBe(true);
  });

  test('renders all prompts as orphan rows when there are no tasks', () => {
    const rows = buildSessionTimelineRows(
      detail({
        prompts: [prompt('late', '2026-07-18T10:40:00.000Z'), prompt('early', '2026-07-18T10:10:00.000Z')],
      }),
    );

    expect(rows.map((row) => (row.kind === 'orphan-prompt' ? row.prompt.id : 'task'))).toEqual(['early', 'late']);
  });

  test('breaks equal row timestamps by their source index', () => {
    const sharedTimestamp = '2026-07-18T10:10:00.000Z';
    const rows = buildSessionTimelineRows(
      detail({
        prompts: [prompt('orphan', sharedTimestamp)],
        turns: [turn(2, sharedTimestamp, '2026-07-18T10:20:00.000Z')],
      }),
    );

    expect(rows.map(({ kind }) => kind)).toEqual(['orphan-prompt', 'task']);
  });

  test('keeps wall-clock scale positions identical to the existing timeline', () => {
    const session = detail({
      turns: [turn(0, '2026-07-18T10:10:00.000Z', '2026-07-18T10:50:00.000Z')],
    });
    const scale = buildTimelineScale(session, 'wall-clock');
    const intervals: ReadonlyArray<readonly [string, string]> = [
      ['2026-07-18T09:50:00.000Z', '2026-07-18T10:15:00.000Z'],
      ['2026-07-18T10:15:00.000Z', '2026-07-18T10:45:00.000Z'],
      ['2026-07-18T10:50:00.000Z', '2026-07-18T11:10:00.000Z'],
    ];

    for (const [startAt, endAt] of intervals) {
      expect(positionOnScale(scale, startAt, endAt)).toEqual(
        positionOnTimeline(startAt, endAt, session.startedAt, session.endedAt),
      );
    }
  });

  test('keeps compressed scale linear when no gap exceeds the threshold', () => {
    const session = detail({
      turns: [
        turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:10:00.000Z'),
        turn(1, '2026-07-18T10:25:00.000Z', '2026-07-18T10:35:00.000Z'),
      ],
    });
    const scale = buildTimelineScale(session, 'compressed');

    expect(GAP_COMPRESSION_THRESHOLD_MS).toBe(15 * 60 * 1000);
    expect(timelineHasCompressibleGaps(session)).toBe(false);
    expect(scale.breaks).toEqual([]);
    expect(positionOnScale(scale, session.startedAt, session.endedAt)).toEqual({
      leftPercent: 0,
      widthPercent: 100,
    });
    expect(positionOnScale(scale, '2026-07-18T10:15:00.000Z', '2026-07-18T10:45:00.000Z')).toEqual(
      positionOnTimeline('2026-07-18T10:15:00.000Z', '2026-07-18T10:45:00.000Z', session.startedAt, session.endedAt),
    );
  });

  test('compresses each long inter-block gap to two percent', () => {
    const session = detail({
      activeDurationMs: 10 * 3_600_000,
      elapsedDurationMs: 18 * 3_600_000,
      endedAt: '2026-07-19T04:00:00.000Z',
      idleDurationMs: 8 * 3_600_000,
      turns: [
        turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T12:00:00.000Z'),
        turn(1, '2026-07-18T17:00:00.000Z', '2026-07-18T21:00:00.000Z'),
        turn(2, '2026-07-19T00:00:00.000Z', '2026-07-19T04:00:00.000Z'),
      ],
    });
    const scale = buildTimelineScale(session, 'compressed');
    const positions = [
      positionOnScale(scale, '2026-07-18T10:00:00.000Z', '2026-07-18T12:00:00.000Z'),
      positionOnScale(scale, '2026-07-18T12:00:00.000Z', '2026-07-18T17:00:00.000Z'),
      positionOnScale(scale, '2026-07-18T17:00:00.000Z', '2026-07-18T21:00:00.000Z'),
      positionOnScale(scale, '2026-07-18T21:00:00.000Z', '2026-07-19T00:00:00.000Z'),
      positionOnScale(scale, '2026-07-19T00:00:00.000Z', '2026-07-19T04:00:00.000Z'),
    ];

    expect(timelineHasCompressibleGaps(session)).toBe(true);
    expect(scale.breaks).toHaveLength(2);
    expect(scale.breaks.map(({ gapMs }) => gapMs)).toEqual([5 * 3_600_000, 3 * 3_600_000]);
    expect(scale.breaks[0]?.atPercent).toBeCloseTo(20.2);
    expect(scale.breaks[1]?.atPercent).toBeCloseTo(60.6);
    const expectedWidths = [19.2, 2, 38.4, 2, 38.4];
    const widthComparisons = positions.map((position, index) => ({
      actual: position.widthPercent,
      expected: expectedWidths[index] ?? Number.NaN,
    }));
    for (const { actual, expected } of widthComparisons) {
      expect(actual).toBeCloseTo(expected);
    }
    expect(positions.reduce((total, { widthPercent }) => total + widthPercent, 0)).toBeCloseTo(100);
  });

  test('clamps compressed positions and preserves monotonicity', () => {
    const session = detail({
      turns: [
        turn(0, '2026-07-18T10:00:00.000Z', '2026-07-18T10:10:00.000Z'),
        turn(1, '2026-07-18T10:40:00.000Z', '2026-07-18T11:00:00.000Z'),
      ],
    });
    const scale = buildTimelineScale(session, 'compressed');
    const firstTimestamp = '2026-07-18T09:00:00.000Z';
    const lastTimestamp = '2026-07-18T12:00:00.000Z';
    const timestamps = [
      firstTimestamp,
      '2026-07-18T10:00:00.000Z',
      '2026-07-18T10:20:00.000Z',
      '2026-07-18T10:40:00.000Z',
      '2026-07-18T11:00:00.000Z',
      lastTimestamp,
    ];
    const points = timestamps.map((value) => positionOnScale(scale, value, value).leftPercent);

    expect(positionOnScale(scale, firstTimestamp, lastTimestamp)).toEqual({
      leftPercent: 0,
      widthPercent: 100,
    });
    expect(positionOnScale(scale, '2026-07-18T10:50:00.000Z', '2026-07-18T10:30:00.000Z').widthPercent).toBe(0);
    let previousPoint = points[0] ?? 0;
    for (const point of points.slice(1)) {
      expect(point).toBeGreaterThanOrEqual(previousPoint);
      previousPoint = point;
    }
  });

  test('keeps every fixed-width break when gaps consume the axis', () => {
    const sessionStartMs = Date.parse('2026-07-18T10:00:00.000Z');
    const minuteMs = 60_000;
    const turns = Array.from({ length: 51 }, (_, index) => {
      const startAt = new Date(sessionStartMs + index * 17 * minuteMs).toISOString();
      const endAt = new Date(Date.parse(startAt) + minuteMs).toISOString();
      return turn(index, startAt, endAt);
    });
    const endedAt = turns.at(-1)?.endAt ?? new Date(sessionStartMs).toISOString();
    const session = detail({
      activeDurationMs: turns.length * minuteMs,
      elapsedDurationMs: Date.parse(endedAt) - sessionStartMs,
      endedAt,
      idleDurationMs: (turns.length - 1) * 16 * minuteMs,
      turns,
    });
    const scale = buildTimelineScale(session, 'compressed');

    expect(timelineHasCompressibleGaps(session)).toBe(true);
    expect(scale.breaks).toHaveLength(50);
    expect(positionOnScale(scale, session.startedAt, session.endedAt)).toEqual({
      leftPercent: 0,
      widthPercent: 100,
    });
    const middleTurn = turns[25];
    if (!middleTurn) {
      throw new Error('Expected the generated timeline to contain a middle task.');
    }
    expect(positionOnScale(scale, middleTurn.startAt, middleTurn.endAt).widthPercent).toBe(0);
    expect(scale.breaks.every(({ atPercent }) => atPercent >= 0 && atPercent <= 100)).toBe(true);
  });

  test('handles a zero-duration session like the existing timeline', () => {
    const timestamp = '2026-07-18T10:00:00.000Z';
    const session = detail({
      activeDurationMs: 0,
      elapsedDurationMs: 0,
      endedAt: timestamp,
      idleDurationMs: 0,
      startedAt: timestamp,
    });

    for (const mode of ['wall-clock', 'compressed'] as const) {
      const scale = buildTimelineScale(session, mode);
      expect(positionOnScale(scale, timestamp, timestamp)).toEqual({ leftPercent: 0, widthPercent: 100 });
      expect(scale.breaks).toEqual([]);
    }
    expect(timelineHasCompressibleGaps(session)).toBe(false);
  });
});
