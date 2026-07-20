import { css, cx } from '@ai-usage/design-system/css';
import type {
  SessionDetail,
  SessionDetailConsistency,
  SessionDetailPhase,
  SessionDetailResponse,
} from '@ai-usage/report-core/session-detail';
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { SessionAnalysisError } from './session-analysis-error';
import {
  buildSessionTimelineRows,
  buildTimelineScale,
  countActivityBursts,
  countLabel,
  formatSessionDuration,
  phaseTokenShare,
  positionOnScale,
  type SessionDurationSemantics,
  type SessionTimelinePromptRef,
  type SessionTimelineRow,
  sessionDurationCaption,
  sessionDurationSemantics,
  type TimelineScale,
  type TimelineScaleMode,
  timelineHasCompressibleGaps,
} from './session-analysis-model';
import {
  buildSessionAnalysisPresentation,
  type SessionAnalysisPresentationItem,
} from './session-analysis-presentation';
import type { SessionAnalysisTarget } from './session-analysis-target';

export interface SessionAnalysisProps {
  error?: SessionAnalysisError | null;
  harnessKey: string;
  loading: boolean;
  onRetry?: () => void;
  response: SessionDetailResponse | null;
  target: SessionAnalysisTarget;
}

const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
});
const compactNumberFormatter = new Intl.NumberFormat('en', {
  maximumFractionDigits: 1,
  notation: 'compact',
});
const moneyFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
});
const subDollarMoneyFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 4,
  minimumFractionDigits: 4,
  style: 'currency',
});
const COLLAPSE_WHITESPACE = /\s+/g;
const PROMPT_PREVIEW_LENGTH = 120;

const panel = css({ display: 'grid', gap: '20px', minW: 0, w: 'full' });
const header = css({ display: 'grid', gap: '5px' });
const heading = css({ color: 'ink', fontSize: '18px', fontWeight: 700, lineHeight: 1.25, m: 0 });
const sectionHeading = css({ color: 'ink', fontSize: '14px', fontWeight: 700, lineHeight: 1.3, m: 0 });
const muted = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });
const numeric = css({ fontFamily: 'mono', fontVariantNumeric: 'tabular-nums' });
const section = css({ display: 'grid', gap: '12px', minW: 0 });
const sectionHeader = css({ display: 'grid', gap: '3px' });
const durationCaption = css({ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', color: 'muted', fontSize: '11px' });
const durationCaptionPart = css({ whiteSpace: 'nowrap' });
const notice = css({
  display: 'grid',
  gap: '4px',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'accentTint',
  color: 'ink',
  fontSize: '12px',
  lineHeight: 1.5,
});
const warningNotice = css({ bg: 'status.warnSoft', borderColor: 'status.warn', color: 'ink' });
const timelineShell = css({
  display: 'grid',
  gap: '8px',
  minW: 0,
  p: { base: '10px', md: '12px' },
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
const timelineAxis = css({
  display: 'grid',
  gridTemplateColumns: {
    base: 'minmax(0, 1fr)',
    md: 'minmax(220px, 0.42fr) minmax(0, 1fr) minmax(72px, 0.16fr)',
  },
  gap: '12px',
  alignItems: 'end',
});
const timelineAxisSpacer = css({ display: { base: 'none', md: 'block' } });
const axisLabels = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '10px',
  color: 'faint',
  fontFamily: 'mono',
  fontSize: '10px',
  fontVariantNumeric: 'tabular-nums',
});
const axisTrack = css({ position: 'relative', minW: 0 });
const axisTokenHeading = css({
  display: { base: 'none', md: 'block' },
  color: 'faint',
  fontSize: '10px',
  fontWeight: 650,
});
const scaleBreak = css({
  position: 'absolute',
  top: '-2px',
  color: 'ink',
  fontSize: '14px',
  fontWeight: 700,
  lineHeight: 1,
  transform: 'translateX(-50%)',
});
const timelineList = css({ display: 'grid', gap: '7px', listStyle: 'none', m: 0, p: 0 });
const timelineRow = css({
  display: 'grid',
  gridTemplateColumns: {
    base: 'minmax(0, 1fr)',
    md: 'minmax(220px, 0.42fr) minmax(0, 1fr) minmax(72px, 0.16fr)',
  },
  gap: { base: '5px', md: '12px' },
  alignItems: 'center',
  minW: 0,
});
const timelineLabel = css({ minW: 0 });
const timelineLabelTop = css({
  display: 'flex',
  gap: '6px',
  alignItems: 'center',
  minW: 0,
  color: 'ink',
  fontSize: '12px',
  fontWeight: 650,
});
const timelineLabelText = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
const timelineMeta = css({ color: 'muted', fontSize: '10px', lineHeight: 1.4, overflowWrap: 'anywhere' });
const timelineTrack = css({
  position: 'relative',
  h: '20px',
  minW: 0,
  overflow: 'hidden',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'track',
});
const wallClockTrack = css({
  backgroundImage:
    'linear-gradient(to right, transparent 24.8%, token(colors.line) 25%, transparent 25.2%, transparent 49.8%, token(colors.line) 50%, transparent 50.2%, transparent 74.8%, token(colors.line) 75%, transparent 75.2%)',
});
const timelineBar = css({
  position: 'absolute',
  top: '3px',
  bottom: '3px',
  borderRadius: '4px',
});
const turnBar = css({ bg: 'accent', boxShadow: '0 0 0 1px token(colors.focusRing)' });
const pointMarker = css({
  position: 'absolute',
  top: '5px',
  w: '8px',
  h: '8px',
  bg: 'accent',
  border: '1px solid token(colors.focusRing)',
  transform: 'translateX(-50%) rotate(45deg)',
});
const phaseDot = css({ flex: '0 0 auto', w: '8px', h: '8px', borderRadius: 'full' });
const phaseToneClasses = [
  css({ bg: 'chart.c1' }),
  css({ bg: 'chart.c2' }),
  css({ bg: 'chart.c3' }),
  css({ bg: 'chart.c4' }),
  css({ bg: 'chart.c5' }),
  css({ bg: 'chart.c6' }),
] as const;
const empty = css({
  p: '14px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  color: 'muted',
  fontSize: '12px',
  textAlign: 'center',
});
const promptDisclosure = css({
  overflow: 'hidden',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
const promptSummary = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gap: '9px',
  alignItems: 'center',
  p: '10px 12px',
  color: 'ink',
  cursor: 'pointer',
  listStyle: 'none',
  fontSize: '12px',
  '&::-webkit-details-marker': { display: 'none' },
  _hover: { bg: 'accentTint' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
});
const promptChevron = css({ color: 'accent', fontSize: '11px', '[open] &': { transform: 'rotate(90deg)' } });
const promptLabelContent = css({ display: 'grid', gap: '2px', minW: 0 });
const promptTitleRow = css({ display: 'flex', gap: '7px', alignItems: 'baseline', minW: 0 });
const promptPreview = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
const pill = css({
  px: '7px',
  py: '2px',
  borderRadius: 'full',
  bg: 'status.warnSoft',
  color: 'status.warn',
  fontSize: '10px',
  fontWeight: 700,
  whiteSpace: 'nowrap',
});
const promptBody = css({
  p: '12px',
  borderTop: '1px solid token(colors.line)',
  bg: 'surface',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '11px',
  lineHeight: 1.6,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
});
const promptEntry = css({
  display: 'grid',
  gap: '5px',
  '& + &': { borderTop: '1px solid token(colors.line)', mt: '10px', pt: '10px' },
});
const promptEntryMeta = css({ display: 'flex', flexWrap: 'wrap', gap: '7px', alignItems: 'center' });
const tokenCell = css({ display: { base: 'none', md: 'flex' }, gap: '7px', alignItems: 'center', minW: 0 });
const tokenTrack = css({ flex: '1 1 auto', h: '6px', overflow: 'hidden', borderRadius: 'sm', bg: 'track' });
const tokenBar = css({ display: 'block', h: 'full', bg: 'accent' });
const tokenValue = css({
  flex: '0 0 auto',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '10px',
  fontVariantNumeric: 'tabular-nums',
});
const phaseLegend = css({ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' });
const scaleButton = css({
  justifySelf: 'start',
  px: '8px',
  py: '5px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  fontSize: '11px',
  fontWeight: 650,
  _hover: { borderColor: 'accent', color: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
const statePanel = css({
  display: 'grid',
  placeItems: 'center',
  gap: '10px',
  minH: '220px',
  p: '24px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
  color: 'muted',
  textAlign: 'center',
});
const stateTitle = css({ color: 'ink', fontSize: '15px', fontWeight: 700 });
const visuallyHidden = css({ srOnly: true });
const retryButton = css({
  px: '12px',
  py: '7px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 650,
  _hover: { borderColor: 'accent', color: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});

const fmtDateTime = (value: string): string => dateTimeFormatter.format(new Date(value));
const fmtTokens = (tokens: number): string => compactNumberFormatter.format(tokens);
const fmtCount = (count: number, noun: string): string =>
  `${fmtTokens(count)}${countLabel(count, noun).slice(String(count).length)}`;
const fmtShare = (share: number): string => `${share >= 10 ? share.toFixed(0) : share.toFixed(1)}%`;
const fmtEffort = (effort: string | null, effortKind: SessionDetailPhase['effortKind']): string => {
  if (effort !== null) {
    return effort;
  }
  return effortKind === 'default' ? 'default effort' : 'effort not recorded';
};
const phaseKey = (phase: SessionDetailPhase): string =>
  `${phase.model}\u0000${phase.effortKind}\u0000${phase.effort ?? ''}`;
const phaseToneIndex = (phase: SessionDetailPhase, phases: readonly SessionDetailPhase[]): number => {
  const uniqueKeys = [...new Set(phases.map(phaseKey))];
  return Math.max(0, uniqueKeys.indexOf(phaseKey(phase))) % phaseToneClasses.length;
};
const phaseTone = (phase: SessionDetailPhase, phases: readonly SessionDetailPhase[]): string =>
  phaseToneClasses[phaseToneIndex(phase, phases)] ?? phaseToneClasses[0];
const promptPreviewText = (text: string): string => {
  const normalized = text.replace(COLLAPSE_WHITESPACE, ' ').trim();
  if (!normalized) {
    return '';
  }
  const preview = normalized.length > PROMPT_PREVIEW_LENGTH ? normalized.slice(0, PROMPT_PREVIEW_LENGTH) : normalized;
  return `${preview.trimEnd()}…`;
};
const formatPhaseCost = (phase: SessionDetailPhase): string => {
  if (phase.cost === null) {
    return 'price unknown';
  }
  const formatter = phase.cost >= 1 ? moneyFormatter : subDollarMoneyFormatter;
  const formatted = formatter.format(phase.cost);
  return phase.costKind === 'approximate' ? `≈ ${formatted}` : `${formatted} reported`;
};
const phaseAt = (phases: readonly SessionDetailPhase[], timestamp: string): SessionDetailPhase | null => {
  const timestampMs = Date.parse(timestamp);
  const phase = phases.find(
    (candidate) => timestampMs >= Date.parse(candidate.startAt) && timestampMs < Date.parse(candidate.endAt),
  );
  if (phase) {
    return phase;
  }
  const lastPhase = phases.at(-1);
  return lastPhase && timestampMs === Date.parse(lastPhase.endAt) ? lastPhase : null;
};

type TaskTimelineRow = Extract<SessionTimelineRow, { kind: 'task' }>;

const taskBounds = (row: TaskTimelineRow): { endAt: string; startAt: string } | null => {
  const chronologicalIntervals = [...row.intervals].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
  const firstInterval = chronologicalIntervals[0];
  if (!firstInterval) {
    return null;
  }
  const endAt = chronologicalIntervals.reduce(
    (latest, interval) => (Date.parse(interval.endAt) > Date.parse(latest) ? interval.endAt : latest),
    firstInterval.endAt,
  );
  return { endAt, startAt: firstInterval.startAt };
};

const TimelineAxis = (props: { endedAt: string; scale: TimelineScale; showTokens?: boolean; startedAt: string }) => (
  <div class={timelineAxis}>
    <span aria-hidden="true" class={timelineAxisSpacer} />
    <div class={axisTrack}>
      <div class={axisLabels}>
        <time dateTime={props.startedAt}>{fmtDateTime(props.startedAt)}</time>
        <span aria-hidden="true">{props.scale.mode === 'compressed' ? 'Compressed gaps' : 'Wall-clock time'}</span>
        <time dateTime={props.endedAt}>{fmtDateTime(props.endedAt)}</time>
      </div>
      <For each={props.scale.breaks}>
        {(scaleBreakItem) => (
          <span
            aria-hidden="true"
            class={scaleBreak}
            style={{ left: `${scaleBreakItem.atPercent}%` }}
            title={formatSessionDuration(scaleBreakItem.gapMs)}
          >
            ⫽
          </span>
        )}
      </For>
    </div>
    <span class={axisTokenHeading}>{props.showTokens ? 'Tokens' : ''}</span>
  </div>
);

const PhaseRow = (props: {
  phase: SessionDetailPhase;
  phases: readonly SessionDetailPhase[];
  scale: TimelineScale;
}) => {
  const position = createMemo(() => positionOnScale(props.scale, props.phase.startAt, props.phase.endAt));
  const share = createMemo(() => phaseTokenShare(props.phase, props.phases));
  const effort = () => fmtEffort(props.phase.effort, props.phase.effortKind);
  const accessibleLabel = () =>
    `${props.phase.model}, ${effort()}, ${fmtShare(share())} of tokens, ${formatPhaseCost(props.phase)}, from ${fmtDateTime(props.phase.startAt)} to ${fmtDateTime(props.phase.endAt)}`;

  return (
    <li class={timelineRow}>
      <div class={timelineLabel}>
        <div class={timelineLabelTop}>
          <span aria-hidden="true" class={cx(phaseDot, phaseTone(props.phase, props.phases))} />
          <span class={timelineLabelText} title={props.phase.model}>
            {props.phase.model}
          </span>
        </div>
        <div class={timelineMeta}>
          {effort()} · {fmtShare(share())} tokens · {formatPhaseCost(props.phase)}
        </div>
      </div>
      <div
        aria-label={accessibleLabel()}
        class={cx(timelineTrack, props.scale.mode === 'wall-clock' && wallClockTrack)}
        role="img"
      >
        <span
          aria-hidden="true"
          class={cx(timelineBar, phaseTone(props.phase, props.phases))}
          style={{ left: `${position().leftPercent}%`, width: `${position().widthPercent}%` }}
        />
      </div>
      <span aria-hidden="true" />
    </li>
  );
};

const PromptBodies = (props: { prompts: readonly SessionTimelinePromptRef[] }) => (
  <div class={promptBody}>
    <Show
      fallback={<span class={muted}>No prompt text was available in local history.</span>}
      when={props.prompts.length > 0}
    >
      <For each={props.prompts}>
        {(prompt) => (
          <div class={promptEntry}>
            <div class={promptEntryMeta}>
              <time class={muted} dateTime={prompt.timestamp}>
                {fmtDateTime(prompt.timestamp)}
              </time>
              <Show when={prompt.truncated}>
                <span class={pill}>Truncated</span>
              </Show>
            </div>
            <span>{prompt.text}</span>
          </div>
        )}
      </For>
    </Show>
  </div>
);

const TaskRow = (props: {
  dominantPhase: SessionDetailPhase | null;
  durationSemantics: SessionDurationSemantics;
  multiPhase: boolean;
  phases: readonly SessionDetailPhase[];
  row: TaskTimelineRow;
  scale: TimelineScale;
}) => {
  const positions = createMemo(() =>
    props.row.intervals.map((interval) => positionOnScale(props.scale, interval.startAt, interval.endAt)),
  );
  const bounds = createMemo(() => taskBounds(props.row));
  const taskPhase = createMemo(() => {
    const rowBounds = bounds();
    return rowBounds ? phaseAt(props.phases, rowBounds.startAt) : null;
  });
  const taskTone = createMemo(() => {
    const phase = taskPhase();
    if (!(props.multiPhase && phase)) {
      return { className: turnBar, index: undefined };
    }
    return { className: phaseTone(phase, props.phases), index: phaseToneIndex(phase, props.phases) };
  });
  const primaryPrompt = () => props.row.prompts[0] ?? null;
  const label = () => {
    const prompt = primaryPrompt();
    const preview = prompt ? promptPreviewText(prompt.text) : '';
    return preview || `${props.durationSemantics.rowNoun} ${props.row.index + 1}`;
  };
  const effort = () => fmtEffort(props.row.effort, props.row.effortKind);
  const showPhaseMeta = () => {
    const dominant = props.dominantPhase;
    return (
      props.multiPhase &&
      (!dominant ||
        props.row.model !== dominant.model ||
        props.row.effort !== dominant.effort ||
        props.row.effortKind !== dominant.effortKind)
    );
  };
  const accessibleLabel = () => {
    const rowBounds = bounds();
    const timeBounds = rowBounds
      ? `, from ${fmtDateTime(rowBounds.startAt)} to ${fmtDateTime(rowBounds.endAt)}`
      : ', recorded time bounds unavailable';
    return `${label()}, ${props.row.model}, ${effort()}, ${formatSessionDuration(props.row.durationMs)} ${props.durationSemantics.turnSpanNoun} across ${countLabel(props.row.intervals.length, 'segment')}, ${countLabel(props.row.tokens.total, 'token')}, ${countLabel(props.row.tools, 'tool')} and ${countLabel(props.row.prompts.length, 'prompt')}${timeBounds}`;
  };

  return (
    <li class={timelineRow} data-session-analysis-row="task">
      <details class={promptDisclosure}>
        <summary class={promptSummary}>
          <span aria-hidden="true" class={promptChevron}>
            ▶
          </span>
          <span class={promptLabelContent}>
            <span class={promptTitleRow}>
              <span class={promptPreview}>{label()}</span>
              <span class={muted} title={props.durationSemantics.metricHint}>
                {formatSessionDuration(props.row.durationMs)}
              </span>
            </span>
            <span class={timelineMeta}>
              <Show when={showPhaseMeta()}>
                {props.row.model} · {effort()} ·{' '}
              </Show>
              {fmtCount(props.row.tokens.total, 'token')} · {countLabel(props.row.tools, 'tool')} ·{' '}
              {countLabel(props.row.prompts.length, 'prompt')}
            </span>
          </span>
        </summary>
        <PromptBodies prompts={props.row.prompts} />
      </details>
      <div
        aria-label={accessibleLabel()}
        class={cx(timelineTrack, props.scale.mode === 'wall-clock' && wallClockTrack)}
        role="img"
      >
        <For each={positions()}>
          {(position) => (
            <span
              aria-hidden="true"
              class={cx(timelineBar, taskTone().className)}
              data-session-analysis-phase-tone={taskTone().index}
              style={{ left: `${position.leftPercent}%`, width: `${position.widthPercent}%` }}
            />
          )}
        </For>
      </div>
      <div class={tokenCell}>
        <span aria-hidden="true" class={tokenTrack}>
          <span class={tokenBar} style={{ width: `${props.row.tokenShareOfMax * 100}%` }} />
        </span>
        <span class={tokenValue}>{fmtTokens(props.row.tokens.total)}</span>
      </div>
    </li>
  );
};

const OrphanPromptRow = (props: {
  durationSemantics: SessionDurationSemantics;
  prompt: SessionTimelinePromptRef;
  scale: TimelineScale;
}) => {
  const label = () => promptPreviewText(props.prompt.text) || 'Prompt';
  const position = createMemo(() => positionOnScale(props.scale, props.prompt.timestamp, props.prompt.timestamp));
  const accessibleLabel = () =>
    `${label()}, orphan prompt, 0s ${props.durationSemantics.turnSpanNoun}, tokens unavailable, 0 tools, point event with no task attribution, from ${fmtDateTime(props.prompt.timestamp)} to ${fmtDateTime(props.prompt.timestamp)}`;

  return (
    <li class={timelineRow} data-session-analysis-row="orphan-prompt">
      <details class={promptDisclosure}>
        <summary class={promptSummary}>
          <span aria-hidden="true" class={promptChevron}>
            ▶
          </span>
          <span class={promptLabelContent}>
            <span class={promptPreview}>{label()}</span>
            <time class={timelineMeta} dateTime={props.prompt.timestamp}>
              {fmtDateTime(props.prompt.timestamp)} · prompt without task attribution
            </time>
          </span>
        </summary>
        <PromptBodies prompts={[props.prompt]} />
      </details>
      <div
        aria-label={accessibleLabel()}
        class={cx(timelineTrack, props.scale.mode === 'wall-clock' && wallClockTrack)}
        role="img"
      >
        <span
          aria-hidden="true"
          class={pointMarker}
          data-session-analysis-point
          style={{ left: `${position().leftPercent}%` }}
        />
      </div>
      <span class={tokenCell}>
        <span class={tokenValue}>—</span>
      </span>
    </li>
  );
};

const UnifiedTimelineRow = (props: {
  dominantPhase: SessionDetailPhase | null;
  durationSemantics: SessionDurationSemantics;
  multiPhase: boolean;
  phases: readonly SessionDetailPhase[];
  row: SessionTimelineRow;
  scale: TimelineScale;
}) => {
  if (props.row.kind === 'orphan-prompt') {
    return (
      <OrphanPromptRow durationSemantics={props.durationSemantics} prompt={props.row.prompt} scale={props.scale} />
    );
  }
  return (
    <TaskRow
      dominantPhase={props.dominantPhase}
      durationSemantics={props.durationSemantics}
      multiPhase={props.multiPhase}
      phases={props.phases}
      row={props.row}
      scale={props.scale}
    />
  );
};

const EmptyTimeline = (props: { children: string }) => <div class={empty}>{props.children}</div>;

const BoundedValue = (props: { bound: 'lower' | 'upper' | null; value: string }) => (
  <>
    <Show when={props.bound !== null}>
      <span class={visuallyHidden}>{props.bound === 'lower' ? 'At least ' : 'At most '}</span>
      <span aria-hidden="true">{props.bound === 'lower' ? '≥ ' : '≤ '}</span>
    </Show>
    {props.value}
  </>
);

const PresentationItem = (props: { item: SessionAnalysisPresentationItem }) => (
  <div
    class={props.item.tone === 'warning' ? cx(notice, warningNotice) : muted}
    data-session-analysis-item={props.item.kind}
    data-tone={props.item.tone}
    role={props.item.tone === 'warning' ? 'status' : undefined}
  >
    <span>{props.item.text}</span>
  </div>
);

const AvailableSessionAnalysis = (props: {
  consistency: SessionDetailConsistency;
  detail: SessionDetail;
  harnessKey: string;
  target: SessionAnalysisTarget;
}) => {
  const chronologicalPhases = createMemo(() =>
    [...props.detail.phases].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)),
  );
  const timelineRows = createMemo(() => buildSessionTimelineRows(props.detail));
  const burstCount = createMemo(() => countActivityBursts(props.detail.turns));
  const promptDataTruncated = createMemo(
    () => props.detail.promptsTruncated || props.detail.prompts.some(({ truncated }) => truncated),
  );
  const durationSemantics = createMemo(() =>
    sessionDurationSemantics(props.harnessKey, props.target.kind === 'campaign-root'),
  );
  const presentationItems = createMemo(() =>
    buildSessionAnalysisPresentation({
      consistency: props.consistency,
      durationPartialBody: durationSemantics().partialBody,
      durationStatus: props.detail.durationStatus,
      promptDataTruncated: promptDataTruncated(),
      target: props.target,
      turnsStatus: props.detail.turnsStatus,
    }),
  );
  const itemsOfKind = (kind: SessionAnalysisPresentationItem['kind']) =>
    presentationItems().filter((item) => item.kind === kind);
  const durationParts = createMemo(() => sessionDurationCaption(props.detail, durationSemantics(), burstCount()));
  const [scaleMode, setScaleMode] = createSignal<TimelineScaleMode>('compressed');
  const scale = createMemo(() => buildTimelineScale(props.detail, scaleMode()));
  const hasCompressibleGaps = createMemo(() => timelineHasCompressibleGaps(props.detail));
  const multiPhase = () => chronologicalPhases().length > 1;
  const dominantPhase = createMemo(() => {
    const phases = chronologicalPhases();
    return phases.reduce<SessionDetailPhase | null>(
      (dominant, phase) => (!dominant || phase.tokens.total > dominant.tokens.total ? phase : dominant),
      null,
    );
  });
  const toggleScale = () => {
    setScaleMode((current) => (current === 'compressed' ? 'wall-clock' : 'compressed'));
  };

  return (
    <div class={panel}>
      <header class={header}>
        <h2 class={heading}>Session analysis</h2>
        <div class={muted}>
          <time dateTime={props.detail.startedAt}>{fmtDateTime(props.detail.startedAt)}</time>
          {' → '}
          <time dateTime={props.detail.endedAt}>{fmtDateTime(props.detail.endedAt)}</time>
          {' · '}session <span class={numeric}>{props.detail.sourceSessionId}</span>
        </div>
        <For each={itemsOfKind('consistency-meta')}>{(item) => <PresentationItem item={item} />}</For>
        <For each={itemsOfKind('scope')}>{(item) => <PresentationItem item={item} />}</For>
        <For each={itemsOfKind('consistency-warning')}>{(item) => <PresentationItem item={item} />}</For>
      </header>

      <section aria-labelledby="session-timeline" class={section}>
        <div class={sectionHeader}>
          <h3 class={sectionHeading} id="session-timeline">
            {durationSemantics().timelineHeading}
          </h3>
          <div class={durationCaption}>
            <For each={durationParts()}>
              {(part, index) => (
                <span class={durationCaptionPart} data-session-analysis-metric={part.key} title={part.hint}>
                  <Show when={index() > 0}> · </Show>
                  {part.label} <BoundedValue bound={part.bound} value={part.value} />
                </span>
              )}
            </For>
          </div>
          <For each={itemsOfKind('partial-duration')}>{(item) => <PresentationItem item={item} />}</For>
          <div class={muted}>{durationSemantics().timelineDescription}</div>
          <For each={itemsOfKind('partial-turns')}>{(item) => <PresentationItem item={item} />}</For>
          <For each={itemsOfKind('privacy')}>{(item) => <PresentationItem item={item} />}</For>
          <For each={itemsOfKind('prompt-truncation')}>{(item) => <PresentationItem item={item} />}</For>
          <Show when={hasCompressibleGaps()}>
            <button
              aria-label="Show real gaps"
              aria-pressed={scaleMode() === 'wall-clock'}
              class={scaleButton}
              onClick={toggleScale}
              type="button"
            >
              {scaleMode() === 'compressed' ? 'Show real gaps' : 'Compress gaps'}
            </button>
          </Show>
        </div>
        <Show
          fallback={
            <EmptyTimeline>
              No turn intervals were available in local history. No prompt text was available in local history.
            </EmptyTimeline>
          }
          when={timelineRows().length > 0}
        >
          <div class={timelineShell} data-session-analysis-scale={scaleMode()}>
            <TimelineAxis
              endedAt={props.detail.endedAt}
              scale={scale()}
              showTokens
              startedAt={props.detail.startedAt}
            />
            <ol aria-label="Chronological session tasks and prompts" class={timelineList}>
              <For each={timelineRows()}>
                {(row) => (
                  <UnifiedTimelineRow
                    dominantPhase={dominantPhase()}
                    durationSemantics={durationSemantics()}
                    multiPhase={multiPhase()}
                    phases={chronologicalPhases()}
                    row={row}
                    scale={scale()}
                  />
                )}
              </For>
            </ol>
          </div>
        </Show>
      </section>

      <Show
        fallback={
          <Show when={chronologicalPhases()[0]}>
            {(phase) => (
              <div class={cx(muted, phaseLegend)}>
                <span aria-hidden="true" class={cx(phaseDot, phaseTone(phase(), chronologicalPhases()))} />
                <span>
                  {phase().model} · {fmtEffort(phase().effort, phase().effortKind)} · 100% tokens ·{' '}
                  {formatPhaseCost(phase())}
                </span>
              </div>
            )}
          </Show>
        }
        when={multiPhase()}
      >
        <section aria-labelledby="session-model-phases" class={section}>
          <div class={sectionHeader}>
            <h3 class={sectionHeading} id="session-model-phases">
              Model and effort phases
            </h3>
            <div class={muted}>
              Band position follows the selected timeline scale; percentages show each phase's token share.
            </div>
          </div>
          <div class={timelineShell}>
            <TimelineAxis endedAt={props.detail.endedAt} scale={scale()} startedAt={props.detail.startedAt} />
            <ol aria-label="Chronological model and effort phases" class={timelineList}>
              <For each={chronologicalPhases()}>
                {(phase) => <PhaseRow phase={phase} phases={chronologicalPhases()} scale={scale()} />}
              </For>
            </ol>
          </div>
        </section>
      </Show>

      <div class={muted}>
        Detail observed <time dateTime={props.detail.observedAt}>{fmtDateTime(props.detail.observedAt)}</time> from
        local history.
      </div>
    </div>
  );
};

const StatePanel = (props: {
  actionLabel?: string | undefined;
  busy?: boolean;
  message: string;
  onAction?: (() => void) | undefined;
  title: string;
}) => (
  <div aria-busy={props.busy} class={statePanel}>
    <div class={stateTitle}>{props.title}</div>
    <div>{props.message}</div>
    <Show when={props.actionLabel && props.onAction}>
      <button class={retryButton} onClick={() => props.onAction?.()} type="button">
        {props.actionLabel}
      </button>
    </Show>
  </div>
);

type UnavailableResponse = Extract<SessionDetailResponse, { status: 'unavailable' }>;

const unavailablePresentation = {
  'history-unavailable': { retryable: true, title: 'Local history unavailable' },
  'not-found': { retryable: false, title: 'Local session history not found' },
  'not-local': { retryable: false, title: 'Local history required' },
  'report-provenance-unavailable': { retryable: false, title: 'Session provenance unavailable' },
  'report-row-not-found': { retryable: false, title: 'Session not found in report' },
  'revision-expired': { retryable: false, title: 'Report revision expired' },
  unsupported: { retryable: false, title: 'Analysis not supported' },
} as const satisfies Record<UnavailableResponse['reason'], { retryable: boolean; title: string }>;

export const SessionAnalysis = (props: SessionAnalysisProps) => {
  const unavailable = createMemo(() => {
    const response = props.response;
    if (response?.status !== 'unavailable') {
      return null;
    }
    return { ...response, ...unavailablePresentation[response.reason] };
  });
  const available = createMemo(() => (props.response?.status === 'available' ? props.response : null));
  const liveAnnouncement = createMemo(() => {
    if (props.error) {
      return '';
    }
    if (props.loading) {
      return 'Loading session analysis';
    }
    const unavailableState = unavailable();
    if (unavailableState) {
      return `${unavailableState.title}. ${unavailableState.message}`;
    }
    if (available()) {
      return 'Session analysis loaded';
    }
    return '';
  });

  return (
    <section aria-label="Session analysis" class={panel}>
      <div aria-atomic="true" aria-live="polite" class={visuallyHidden} data-session-analysis-live-status role="status">
        {liveAnnouncement()}
      </div>
      <Switch>
        <Match when={props.error}>
          {(error) => (
            <div role="alert">
              <StatePanel
                actionLabel={error().kind === 'transient' && props.onRetry ? 'Retry' : undefined}
                message={error().message}
                onAction={error().kind === 'transient' ? props.onRetry : undefined}
                title={error().kind === 'transient' ? 'Analysis failed' : 'Analysis unavailable'}
              />
            </div>
          )}
        </Match>
        <Match when={props.loading}>
          <StatePanel busy message="Reading the bounded local session trace…" title="Loading session analysis" />
        </Match>
        <Match when={unavailable()}>
          {(state) => (
            <StatePanel
              actionLabel={state().retryable && props.onRetry ? 'Retry' : undefined}
              message={state().message}
              onAction={state().retryable ? props.onRetry : undefined}
              title={state().title}
            />
          )}
        </Match>
        <Match when={available()}>
          {(response) => (
            <AvailableSessionAnalysis
              consistency={response().consistency}
              detail={response().detail}
              harnessKey={props.harnessKey}
              target={props.target}
            />
          )}
        </Match>
        <Match when={true}>
          <StatePanel message="Select a locally recorded session to inspect its timeline." title="No analysis loaded" />
        </Match>
      </Switch>
    </section>
  );
};
