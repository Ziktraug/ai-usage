import type { SessionDetailPhase, SessionDetailTurn } from '@ai-usage/report-core/session-detail';

export interface TimelinePosition {
  leftPercent: number;
  widthPercent: number;
}

export interface SessionDurationSemantics {
  burstHint: string;
  burstLabel: string;
  elapsedHint: string;
  elapsedLabel: string;
  gapHint: string;
  gapLabel: string;
  metricHint: string;
  metricLabel: string;
  partialBody: string;
  partialTitle: string;
  timelineDescription: string;
  timelineHeading: string;
  turnSpanNoun: string;
}

const CODEX_DURATION_SEMANTICS: SessionDurationSemantics = {
  burstHint: 'Codex task-open intervals are merged into blocks when they overlap or touch.',
  burstLabel: 'Task blocks',
  elapsedHint: 'Wall-clock span from the first local task start to the final local task completion.',
  elapsedLabel: 'Session span',
  gapHint: 'Wall-clock time outside recorded Codex task-open spans.',
  gapLabel: 'Between tasks',
  metricHint:
    'Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime.',
  metricLabel: 'Task-open time',
  partialBody:
    'At least one task-open span was unavailable; task-open time is a lower bound and outside-task time is an upper bound.',
  partialTitle: 'Partial task-time coverage',
  timelineDescription:
    'Bars show when each Codex task was open, including waits for tools or subagents. Empty gaps are time between tasks.',
  timelineHeading: 'Task timeline',
  turnSpanNoun: 'task-open time',
};

const OPENCODE_DURATION_SEMANTICS: SessionDurationSemantics = {
  burstHint: 'Recorded assistant intervals are merged into bursts when they overlap or touch.',
  burstLabel: 'Assistant bursts',
  elapsedHint: 'Wall-clock span from the first to the last recorded OpenCode session event.',
  elapsedLabel: 'Session span',
  gapHint: 'Wall-clock time outside recorded OpenCode assistant intervals.',
  gapLabel: 'Outside assistant',
  metricHint:
    'Union of recorded OpenCode assistant intervals. This is observed assistant wall-clock span, not model runtime.',
  metricLabel: 'Assistant time',
  partialBody:
    'At least one assistant interval was unavailable; assistant time is a lower bound and unattributed time is an upper bound.',
  partialTitle: 'Partial assistant-time coverage',
  timelineDescription:
    'Bars show recorded OpenCode assistant intervals. Empty gaps are time without a completed assistant interval.',
  timelineHeading: 'Assistant timeline',
  turnSpanNoun: 'assistant-interval time',
};

const GENERIC_DURATION_SEMANTICS: SessionDurationSemantics = {
  burstHint: 'Recorded intervals are merged into blocks when they overlap or touch.',
  burstLabel: 'Interval blocks',
  elapsedHint: 'Wall-clock span covered by the available local session trace.',
  elapsedLabel: 'Session span',
  gapHint: 'Wall-clock time outside recorded activity intervals.',
  gapLabel: 'Unattributed',
  metricHint: 'Time covered by recorded activity intervals; this is not model runtime.',
  metricLabel: 'Interval time',
  partialBody:
    'At least one activity interval was unavailable; interval time is a lower bound and unattributed time is an upper bound.',
  partialTitle: 'Partial interval coverage',
  timelineDescription:
    'Bars show recorded intervals on the shared elapsed-time axis. Empty gaps are unattributed time.',
  timelineHeading: 'Recorded timeline',
  turnSpanNoun: 'recorded interval time',
};

const baseDurationSemantics = (harnessKey: string | null | undefined): SessionDurationSemantics => {
  if (harnessKey === 'codex') {
    return CODEX_DURATION_SEMANTICS;
  }
  if (harnessKey === 'opencode') {
    return OPENCODE_DURATION_SEMANTICS;
  }
  return GENERIC_DURATION_SEMANTICS;
};

const rootDurationLabel = (harnessKey: string | null | undefined): string => {
  if (harnessKey === 'codex') {
    return 'Root task-open time';
  }
  if (harnessKey === 'opencode') {
    return 'Root assistant time';
  }
  return 'Root interval time';
};

export const sessionDurationSemantics = (
  harnessKey: string | null | undefined,
  rootSessionOnly = false,
): SessionDurationSemantics => {
  const base = baseDurationSemantics(harnessKey);
  if (!rootSessionOnly) {
    return base;
  }
  return {
    ...base,
    metricHint: `Campaign time uses the root session only. ${base.metricHint}`,
    metricLabel: rootDurationLabel(harnessKey),
  };
};

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const positionOnTimeline = (
  startAt: string,
  endAt: string,
  timelineStartAt: string,
  timelineEndAt: string,
): TimelinePosition => {
  const timelineStart = timestamp(timelineStartAt);
  const timelineEnd = timestamp(timelineEndAt);
  const timelineDuration = timelineEnd - timelineStart;
  if (timelineDuration <= 0) {
    return { leftPercent: 0, widthPercent: 100 };
  }

  const boundedStart = clamp(timestamp(startAt), timelineStart, timelineEnd);
  const boundedEnd = clamp(timestamp(endAt), boundedStart, timelineEnd);
  return {
    leftPercent: ((boundedStart - timelineStart) / timelineDuration) * 100,
    widthPercent: ((boundedEnd - boundedStart) / timelineDuration) * 100,
  };
};

export const phaseTokenShare = (phase: SessionDetailPhase, phases: readonly SessionDetailPhase[]): number => {
  const totalTokens = phases.reduce((total, candidate) => total + candidate.tokens.total, 0);
  return totalTokens > 0 ? (phase.tokens.total / totalTokens) * 100 : 0;
};

export const countActivityBursts = (turns: readonly SessionDetailTurn[]): number => {
  const intervals = turns
    .flatMap((turn) =>
      turn.intervals.map((interval) => ({ end: timestamp(interval.endAt), start: timestamp(interval.startAt) })),
    )
    .filter(({ end, start }) => end >= start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const firstInterval = intervals[0];
  if (!firstInterval) {
    return 0;
  }

  let bursts = 1;
  let currentEnd = firstInterval.end;
  for (const interval of intervals.slice(1)) {
    if (interval.start > currentEnd) {
      bursts += 1;
    }
    currentEnd = Math.max(currentEnd, interval.end);
  }
  return bursts;
};

export const formatSessionDuration = (durationMs: number): string => {
  if (durationMs <= 0) {
    return '0s';
  }
  if (durationMs < 60_000) {
    return `${Math.max(1, Math.round(durationMs / 1000))}s`;
  }

  const totalMinutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};
