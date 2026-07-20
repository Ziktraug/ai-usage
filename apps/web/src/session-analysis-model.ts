import type {
  SessionDetail,
  SessionDetailEffortKind,
  SessionDetailInterval,
  SessionDetailPhase,
  SessionDetailTokenCounts,
  SessionDetailTurn,
} from '@ai-usage/report-core/session-detail';

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
  rowNoun: string;
  timelineDescription: string;
  timelineHeading: string;
  turnSpanNoun: string;
}

const CODEX_DURATION_SEMANTICS: SessionDurationSemantics = {
  burstHint: 'Codex task-open intervals are merged into blocks when they overlap or touch.',
  burstLabel: 'Task blocks',
  elapsedHint: 'Wall-clock span from the first local task start to the last observed local task event.',
  elapsedLabel: 'Session span',
  gapHint: 'Wall-clock time outside recorded Codex task-open spans.',
  gapLabel: 'Between tasks',
  metricHint:
    'Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime.',
  metricLabel: 'Task-open time',
  partialBody: 'Timing coverage is incomplete. Values marked ≥ or ≤ are bounds based on recorded local activity.',
  rowNoun: 'Task',
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
  partialBody: 'Timing coverage is incomplete. Values marked ≥ or ≤ are bounds based on recorded local activity.',
  rowNoun: 'Turn',
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
  partialBody: 'Timing coverage is incomplete. Values marked ≥ or ≤ are bounds based on recorded local activity.',
  rowNoun: 'Turn',
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

export interface SessionTimelinePromptRef {
  id: string;
  text: string;
  timestamp: string;
  truncated: boolean;
}

export type SessionTimelineRow =
  | {
      durationMs: number;
      effort: string | null;
      effortKind: SessionDetailEffortKind;
      index: number;
      intervals: SessionDetailInterval[];
      kind: 'task';
      model: string;
      prompts: SessionTimelinePromptRef[];
      tokenShareOfMax: number;
      tokens: SessionDetailTokenCounts;
      tools: number;
    }
  | { kind: 'orphan-prompt'; prompt: SessionTimelinePromptRef };

export type TimelineScaleMode = 'compressed' | 'wall-clock';

export interface TimelineScaleBreak {
  atPercent: number;
  gapMs: number;
}

interface TimelineScaleSegment {
  endMs: number;
  endPercent: number;
  startMs: number;
  startPercent: number;
}

export interface TimelineScale {
  breaks: TimelineScaleBreak[];
  mode: TimelineScaleMode;
  segments: TimelineScaleSegment[];
  timelineEndAt: string;
  timelineStartAt: string;
}

export interface SessionDurationCaptionPart {
  bound: 'lower' | 'upper' | null;
  hint: string;
  key: 'active' | 'blocks' | 'gap' | 'span';
  label: string;
  value: string;
}

export const GAP_COMPRESSION_THRESHOLD_MS = 15 * 60 * 1000;

const COMPRESSED_GAP_WIDTH_PERCENT = 2;
const MAX_COMPRESSED_GAPS = Math.floor(100 / COMPRESSED_GAP_WIDTH_PERCENT) - 1;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const promptRef = (prompt: SessionDetail['prompts'][number]): SessionTimelinePromptRef => ({
  id: prompt.id,
  text: prompt.text,
  timestamp: prompt.timestamp,
  truncated: prompt.truncated,
});

export const buildSessionTimelineRows = (detail: SessionDetail): SessionTimelineRow[] => {
  const chronologicalTurns = [...detail.turns].sort(
    (left, right) => timestamp(left.startAt) - timestamp(right.startAt) || left.index - right.index,
  );
  const promptOwner = new Map<string, SessionDetailTurn>();
  for (const turn of chronologicalTurns) {
    for (const promptId of turn.promptIds) {
      if (!promptOwner.has(promptId)) {
        promptOwner.set(promptId, turn);
      }
    }
  }

  const promptsByTurn = new Map<SessionDetailTurn, SessionTimelinePromptRef[]>();
  const orphanRows: Array<{
    row: SessionTimelineRow;
    sortAt: number;
    sortIndex: number;
  }> = [];
  const chronologicalPrompts = detail.prompts
    .map((prompt, promptIndex) => ({ prompt, promptIndex }))
    .sort(
      (left, right) =>
        timestamp(left.prompt.timestamp) - timestamp(right.prompt.timestamp) || left.promptIndex - right.promptIndex,
    );

  for (const { prompt, promptIndex } of chronologicalPrompts) {
    const owner = promptOwner.get(prompt.id);
    const reference = promptRef(prompt);
    if (!owner) {
      orphanRows.push({
        row: { kind: 'orphan-prompt', prompt: reference },
        sortAt: timestamp(prompt.timestamp),
        sortIndex: promptIndex,
      });
      continue;
    }
    const ownedPrompts = promptsByTurn.get(owner) ?? [];
    ownedPrompts.push(reference);
    promptsByTurn.set(owner, ownedPrompts);
  }

  const maximumTokens = chronologicalTurns.reduce((maximum, turn) => Math.max(maximum, turn.tokens.total), 0);
  const taskRows = chronologicalTurns.map((turn) => ({
    row: {
      durationMs: turn.durationMs,
      effort: turn.effort,
      effortKind: turn.effortKind,
      index: turn.index,
      intervals: turn.intervals,
      kind: 'task' as const,
      model: turn.model,
      prompts: promptsByTurn.get(turn) ?? [],
      tokenShareOfMax: maximumTokens > 0 ? clamp(turn.tokens.total / maximumTokens, 0, 1) : 0,
      tokens: turn.tokens,
      tools: turn.tools,
    },
    sortAt: timestamp(turn.startAt),
    sortIndex: turn.index,
  }));

  return [...taskRows, ...orphanRows]
    .sort((left, right) => {
      const chronologicalOrder = left.sortAt - right.sortAt || left.sortIndex - right.sortIndex;
      if (chronologicalOrder !== 0 || left.row.kind === right.row.kind) {
        return chronologicalOrder;
      }
      return left.row.kind === 'task' ? -1 : 1;
    })
    .map(({ row }) => row);
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

interface NumericInterval {
  end: number;
  start: number;
}

const mergedActivityBlocks = (turns: readonly SessionDetailTurn[]): NumericInterval[] => {
  const intervals = turns
    .flatMap((turn) =>
      turn.intervals.map((interval) => ({ end: timestamp(interval.endAt), start: timestamp(interval.startAt) })),
    )
    .filter(({ end, start }) => end >= start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const firstInterval = intervals[0];
  if (!firstInterval) {
    return [];
  }

  const blocks: NumericInterval[] = [{ ...firstInterval }];
  for (const interval of intervals.slice(1)) {
    const currentBlock = blocks.at(-1);
    if (!currentBlock) {
      continue;
    }
    if (interval.start > currentBlock.end) {
      blocks.push({ ...interval });
      continue;
    }
    currentBlock.end = Math.max(currentBlock.end, interval.end);
  }
  return blocks;
};

export const countActivityBursts = (turns: readonly SessionDetailTurn[]): number => mergedActivityBlocks(turns).length;

interface CompressibleGap {
  end: number;
  gapMs: number;
  start: number;
}

const compressibleGaps = (detail: SessionDetail): CompressibleGap[] => {
  const timelineStart = timestamp(detail.startedAt);
  const timelineEnd = timestamp(detail.endedAt);
  const blocks = mergedActivityBlocks(detail.turns)
    .map(({ end, start }) => ({
      end: clamp(end, timelineStart, timelineEnd),
      start: clamp(start, timelineStart, timelineEnd),
    }))
    .filter(({ end, start }) => end >= start);
  const gaps: CompressibleGap[] = [];

  for (let index = 1; index < blocks.length; index += 1) {
    const previousBlock = blocks[index - 1];
    const block = blocks[index];
    if (!(previousBlock && block)) {
      continue;
    }
    const gapMs = block.start - previousBlock.end;
    if (gapMs > GAP_COMPRESSION_THRESHOLD_MS) {
      gaps.push({ end: block.start, gapMs, start: previousBlock.end });
    }
  }
  return gaps;
};

const displayableCompressibleGaps = (detail: SessionDetail): CompressibleGap[] => {
  const gaps = compressibleGaps(detail);
  // Preserve wall-clock scale when fixed 2% breaks would consume the whole axis.
  return gaps.length <= MAX_COMPRESSED_GAPS ? gaps : [];
};

export const timelineHasCompressibleGaps = (detail: SessionDetail): boolean =>
  displayableCompressibleGaps(detail).length > 0;

const linearTimelineScale = (detail: SessionDetail, mode: TimelineScaleMode): TimelineScale => ({
  breaks: [],
  mode,
  segments: [],
  timelineEndAt: detail.endedAt,
  timelineStartAt: detail.startedAt,
});

export const buildTimelineScale = (detail: SessionDetail, mode: TimelineScaleMode): TimelineScale => {
  const timelineStart = timestamp(detail.startedAt);
  const timelineEnd = timestamp(detail.endedAt);
  const timelineDuration = timelineEnd - timelineStart;
  if (mode === 'wall-clock' || timelineDuration <= 0) {
    return linearTimelineScale(detail, mode);
  }

  const gaps = displayableCompressibleGaps(detail);
  if (gaps.length === 0) {
    return linearTimelineScale(detail, mode);
  }

  const compressedDuration = gaps.reduce((total, gap) => total + gap.gapMs, 0);
  const proportionalDuration = timelineDuration - compressedDuration;
  const fixedGapWidth = COMPRESSED_GAP_WIDTH_PERCENT;
  const proportionalWidth = 100 - fixedGapWidth * gaps.length;
  const percentPerMillisecond = proportionalDuration > 0 ? proportionalWidth / proportionalDuration : 0;
  const breaks: TimelineScaleBreak[] = [];
  const segments: TimelineScaleSegment[] = [];
  let cursorMs = timelineStart;
  let cursorPercent = 0;

  for (const gap of gaps) {
    const proportionalSegmentWidth = (gap.start - cursorMs) * percentPerMillisecond;
    const gapStartPercent = cursorPercent + proportionalSegmentWidth;
    segments.push({
      endMs: gap.start,
      endPercent: gapStartPercent,
      startMs: cursorMs,
      startPercent: cursorPercent,
    });
    segments.push({
      endMs: gap.end,
      endPercent: gapStartPercent + fixedGapWidth,
      startMs: gap.start,
      startPercent: gapStartPercent,
    });
    breaks.push({ atPercent: gapStartPercent + fixedGapWidth / 2, gapMs: gap.gapMs });
    cursorMs = gap.end;
    cursorPercent = gapStartPercent + fixedGapWidth;
  }

  segments.push({
    endMs: timelineEnd,
    endPercent: 100,
    startMs: cursorMs,
    startPercent: cursorPercent,
  });
  return {
    breaks,
    mode,
    segments,
    timelineEndAt: detail.endedAt,
    timelineStartAt: detail.startedAt,
  };
};

const positionOnCompressedScale = (scale: TimelineScale, valueMs: number): number => {
  for (const segment of scale.segments) {
    if (valueMs > segment.endMs) {
      continue;
    }
    const segmentDuration = segment.endMs - segment.startMs;
    if (segmentDuration <= 0) {
      return clamp(segment.startPercent, 0, 100);
    }
    const progress = (valueMs - segment.startMs) / segmentDuration;
    return clamp(segment.startPercent + progress * (segment.endPercent - segment.startPercent), 0, 100);
  }
  return 100;
};

export const positionOnScale = (scale: TimelineScale, startAt: string, endAt: string): TimelinePosition => {
  if (scale.segments.length === 0) {
    return positionOnTimeline(startAt, endAt, scale.timelineStartAt, scale.timelineEndAt);
  }

  const timelineStart = timestamp(scale.timelineStartAt);
  const timelineEnd = timestamp(scale.timelineEndAt);
  const boundedStart = clamp(timestamp(startAt), timelineStart, timelineEnd);
  const boundedEnd = clamp(timestamp(endAt), boundedStart, timelineEnd);
  const leftPercent = positionOnCompressedScale(scale, boundedStart);
  const endPercent = positionOnCompressedScale(scale, boundedEnd);
  return {
    leftPercent,
    widthPercent: Math.max(0, endPercent - leftPercent),
  };
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

export const countLabel = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const sessionDurationCaption = (
  detail: SessionDetail,
  semantics: SessionDurationSemantics,
  burstCount: number,
): SessionDurationCaptionPart[] => {
  const partial = detail.durationStatus === 'partial';
  return [
    {
      bound: partial ? 'lower' : null,
      hint: semantics.metricHint,
      key: 'active',
      label: semantics.metricLabel,
      value: formatSessionDuration(detail.activeDurationMs),
    },
    {
      bound: null,
      hint: semantics.elapsedHint,
      key: 'span',
      label: semantics.elapsedLabel,
      value: formatSessionDuration(detail.elapsedDurationMs),
    },
    {
      bound: partial ? 'upper' : null,
      hint: semantics.gapHint,
      key: 'gap',
      label: semantics.gapLabel,
      value: formatSessionDuration(detail.idleDurationMs),
    },
    {
      bound: null,
      hint: semantics.burstHint,
      key: 'blocks',
      label: semantics.burstLabel,
      value: String(burstCount),
    },
  ];
};
