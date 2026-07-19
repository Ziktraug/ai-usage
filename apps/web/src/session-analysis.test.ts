import { describe, expect, test } from 'bun:test';
import type { SessionDetailPhase, SessionDetailTurn } from '@ai-usage/report-core/session-detail';
import {
  countActivityBursts,
  formatSessionDuration,
  phaseTokenShare,
  positionOnTimeline,
  sessionDurationSemantics,
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

const turn = (index: number, startAt: string, endAt: string): SessionDetailTurn => ({
  durationMs: Date.parse(endAt) - Date.parse(startAt),
  effort: 'high',
  effortKind: 'recorded',
  endAt,
  index,
  intervals: [{ endAt, startAt }],
  model: 'gpt-5.6-sol',
  promptIds: [],
  startAt,
  tokens: tokens(10),
  tools: 0,
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
      timelineHeading: 'Task timeline',
    });
    expect(sessionDurationSemantics('codex').metricHint).toContain('not model runtime');
    expect(sessionDurationSemantics('opencode')).toMatchObject({
      gapLabel: 'Outside assistant',
      metricLabel: 'Assistant time',
      timelineHeading: 'Assistant timeline',
    });
    expect(sessionDurationSemantics('claude')).toMatchObject({
      gapLabel: 'Unattributed',
      metricLabel: 'Interval time',
    });
    expect(sessionDurationSemantics('codex', true)).toMatchObject({
      metricLabel: 'Root task-open time',
    });
    expect(sessionDurationSemantics('codex', true).metricHint).toContain('root session only');
  });
});
