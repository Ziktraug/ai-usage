import { css, cx } from '@ai-usage/design-system/css';
import type {
  SessionDetail,
  SessionDetailConsistency,
  SessionDetailPhase,
  SessionDetailResponse,
  SessionDetailTurn,
} from '@ai-usage/report-core/session-detail';
import { createMemo, For, Match, Show, Switch } from 'solid-js';
import {
  countActivityBursts,
  formatSessionDuration,
  phaseTokenShare,
  positionOnTimeline,
  type SessionDurationSemantics,
  sessionDurationSemantics,
} from './session-analysis-model';
import {
  buildSessionAnalysisPresentation,
  type SessionAnalysisPresentationItem,
} from './session-analysis-presentation';
import type { SessionAnalysisTarget } from './session-analysis-target';

export interface SessionAnalysisProps {
  error?: string | null;
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
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
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
const metrics = css({
  display: 'grid',
  gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' },
  gap: '8px',
  m: 0,
});
const metric = css({
  display: 'grid',
  gap: '5px',
  minW: 0,
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
const metricLabel = css({ color: 'muted', fontSize: '11px', fontWeight: 650, textTransform: 'uppercase' });
const metricValue = css({
  color: 'ink',
  fontFamily: 'mono',
  fontSize: { base: '17px', md: '20px' },
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 700,
  lineHeight: 1.1,
  m: 0,
});
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
  gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(152px, 0.36fr) minmax(0, 1fr)' },
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
const timelineList = css({ display: 'grid', gap: '7px', listStyle: 'none', m: 0, p: 0 });
const timelineRow = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(152px, 0.36fr) minmax(0, 1fr)' },
  gap: { base: '5px', md: '12px' },
  alignItems: 'center',
  minW: 0,
});
const timelineLabel = css({ display: 'grid', gap: '2px', minW: 0 });
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
  backgroundImage:
    'linear-gradient(to right, transparent 24.8%, token(colors.line) 25%, transparent 25.2%, transparent 49.8%, token(colors.line) 50%, transparent 50.2%, transparent 74.8%, token(colors.line) 75%, transparent 75.2%)',
});
const timelineBar = css({
  position: 'absolute',
  top: '3px',
  bottom: '3px',
  minW: '4px',
  borderRadius: '4px',
});
const turnBar = css({ bg: 'accent', boxShadow: '0 0 0 1px token(colors.focusRing)' });
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
const promptList = css({ display: 'grid', gap: '8px' });
const promptDisclosure = css({
  overflow: 'hidden',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
const promptSummary = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
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
const promptPreview = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
const promptSummaryMeta = css({ display: 'flex', gap: '7px', alignItems: 'center', whiteSpace: 'nowrap' });
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
const fmtShare = (share: number): string => `${share >= 10 ? share.toFixed(0) : share.toFixed(1)}%`;
const fmtEffort = (effort: string | null, effortKind: SessionDetailPhase['effortKind']): string => {
  if (effort !== null) {
    return effort;
  }
  return effortKind === 'default' ? 'default effort' : 'effort not recorded';
};
const phaseKey = (phase: SessionDetailPhase): string =>
  `${phase.model}\u0000${phase.effortKind}\u0000${phase.effort ?? ''}`;
const phaseTone = (phase: SessionDetailPhase, phases: readonly SessionDetailPhase[]): string => {
  const uniqueKeys = [...new Set(phases.map(phaseKey))];
  const index = Math.max(0, uniqueKeys.indexOf(phaseKey(phase)));
  return phaseToneClasses[index % phaseToneClasses.length] ?? phaseToneClasses[0];
};
const promptPreviewText = (text: string): string => {
  const normalized = text.replace(COLLAPSE_WHITESPACE, ' ').trim();
  return normalized.length > PROMPT_PREVIEW_LENGTH
    ? `${normalized.slice(0, PROMPT_PREVIEW_LENGTH).trimEnd()}…`
    : normalized;
};

const TimelineAxis = (props: { endedAt: string; startedAt: string }) => (
  <div class={timelineAxis}>
    <span aria-hidden="true" class={timelineAxisSpacer} />
    <div class={axisLabels}>
      <time dateTime={props.startedAt}>{fmtDateTime(props.startedAt)}</time>
      <span aria-hidden="true">Wall-clock time</span>
      <time dateTime={props.endedAt}>{fmtDateTime(props.endedAt)}</time>
    </div>
  </div>
);

const PhaseRow = (props: { detail: SessionDetail; phase: SessionDetailPhase }) => {
  const position = createMemo(() =>
    positionOnTimeline(props.phase.startAt, props.phase.endAt, props.detail.startedAt, props.detail.endedAt),
  );
  const share = createMemo(() => phaseTokenShare(props.phase, props.detail.phases));
  const effort = () => fmtEffort(props.phase.effort, props.phase.effortKind);
  const cost = () => {
    if (props.phase.cost === null) {
      return 'price unknown';
    }
    const formatted = moneyFormatter.format(props.phase.cost);
    return props.phase.costKind === 'approximate' ? `≈ ${formatted}` : `${formatted} reported`;
  };
  const accessibleLabel = () =>
    `${props.phase.model}, ${effort()}, ${fmtShare(share())} of tokens, ${cost()}, from ${fmtDateTime(props.phase.startAt)} to ${fmtDateTime(props.phase.endAt)}`;

  return (
    <li class={timelineRow}>
      <div class={timelineLabel}>
        <div class={timelineLabelTop}>
          <span aria-hidden="true" class={cx(phaseDot, phaseTone(props.phase, props.detail.phases))} />
          <span class={timelineLabelText} title={props.phase.model}>
            {props.phase.model}
          </span>
        </div>
        <div class={timelineMeta}>
          {effort()} · {fmtShare(share())} tokens · {cost()}
        </div>
      </div>
      <div aria-label={accessibleLabel()} class={timelineTrack} role="img">
        <span
          aria-hidden="true"
          class={cx(timelineBar, phaseTone(props.phase, props.detail.phases))}
          style={{ left: `${position().leftPercent}%`, width: `${position().widthPercent}%` }}
        />
      </div>
    </li>
  );
};

const TurnRow = (props: {
  detail: SessionDetail;
  durationSemantics: SessionDurationSemantics;
  turn: SessionDetailTurn;
}) => {
  const positions = createMemo(() =>
    props.turn.intervals.map((interval) =>
      positionOnTimeline(interval.startAt, interval.endAt, props.detail.startedAt, props.detail.endedAt),
    ),
  );
  const effort = () => fmtEffort(props.turn.effort, props.turn.effortKind);
  const accessibleLabel = () =>
    `Turn ${props.turn.index + 1}, ${props.turn.model}, ${effort()}, ${formatSessionDuration(props.turn.durationMs)} ${props.durationSemantics.turnSpanNoun} across ${props.turn.intervals.length} segments, ${fmtTokens(props.turn.tokens.total)} tokens, ${props.turn.tools} tools and ${props.turn.promptIds.length} prompts, from ${fmtDateTime(props.turn.startAt)} to ${fmtDateTime(props.turn.endAt)}`;

  return (
    <li class={timelineRow}>
      <div class={timelineLabel}>
        <div class={timelineLabelTop}>
          <span class={timelineLabelText}>Turn {props.turn.index + 1}</span>
          <span class={muted} title={props.durationSemantics.metricHint}>
            {formatSessionDuration(props.turn.durationMs)}
          </span>
        </div>
        <div class={timelineMeta} title={`${props.turn.model} · ${effort()}`}>
          {props.turn.model} · {effort()} · {fmtTokens(props.turn.tokens.total)} tokens · {props.turn.tools} tools ·{' '}
          {props.turn.promptIds.length} prompts
        </div>
      </div>
      <div aria-label={accessibleLabel()} class={timelineTrack} role="img">
        <For each={positions()}>
          {(position) => (
            <span
              aria-hidden="true"
              class={cx(timelineBar, turnBar)}
              style={{ left: `${position.leftPercent}%`, width: `${position.widthPercent}%` }}
            />
          )}
        </For>
      </div>
    </li>
  );
};

const EmptyTimeline = (props: { children: string }) => <div class={empty}>{props.children}</div>;

const PresentationItem = (props: { item: SessionAnalysisPresentationItem }) => (
  <div
    class={props.item.tone === 'warning' ? cx(notice, warningNotice) : muted}
    data-session-analysis-item={props.item.kind}
    data-tone={props.item.tone}
    role={props.item.tone === 'warning' ? 'status' : undefined}
  >
    {'title' in props.item ? <strong>{props.item.title}</strong> : null}
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
  const chronologicalTurns = createMemo(() =>
    [...props.detail.turns].sort(
      (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || left.index - right.index,
    ),
  );
  const chronologicalPrompts = createMemo(() =>
    [...props.detail.prompts].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
  );
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
      durationPartialTitle: durationSemantics().partialTitle,
      durationStatus: props.detail.durationStatus,
      promptDataTruncated: promptDataTruncated(),
      target: props.target,
      turnsStatus: props.detail.turnsStatus,
    }),
  );
  const itemsOfKind = (kind: SessionAnalysisPresentationItem['kind']) =>
    presentationItems().filter((item) => item.kind === kind);

  const metricItems = () => [
    {
      hint: durationSemantics().metricHint,
      label: durationSemantics().metricLabel,
      value: formatSessionDuration(props.detail.activeDurationMs),
    },
    {
      hint: durationSemantics().elapsedHint,
      label: durationSemantics().elapsedLabel,
      value: formatSessionDuration(props.detail.elapsedDurationMs),
    },
    {
      hint: durationSemantics().gapHint,
      label: durationSemantics().gapLabel,
      value: formatSessionDuration(props.detail.idleDurationMs),
    },
    {
      hint: durationSemantics().burstHint,
      label: durationSemantics().burstLabel,
      value: String(burstCount()),
    },
  ];

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
      </header>

      <For each={itemsOfKind('consistency-warning')}>{(item) => <PresentationItem item={item} />}</For>
      <For each={itemsOfKind('partial-duration')}>{(item) => <PresentationItem item={item} />}</For>
      <For each={itemsOfKind('partial-turns')}>{(item) => <PresentationItem item={item} />}</For>

      <dl class={metrics}>
        <For each={metricItems()}>
          {(item) => (
            <div class={metric} title={item.hint}>
              <dt class={metricLabel}>{item.label}</dt>
              <dd class={metricValue}>{item.value}</dd>
            </div>
          )}
        </For>
      </dl>

      <section aria-labelledby="session-model-phases" class={section}>
        <div class={sectionHeader}>
          <h3 class={sectionHeading} id="session-model-phases">
            Model and effort phases
          </h3>
          <div class={muted}>Band position follows wall-clock time; percentages show each phase's token share.</div>
        </div>
        <Show
          fallback={<EmptyTimeline>No model or effort changes were recorded for this session.</EmptyTimeline>}
          when={chronologicalPhases().length > 0}
        >
          <div class={timelineShell}>
            <TimelineAxis endedAt={props.detail.endedAt} startedAt={props.detail.startedAt} />
            <ol aria-label="Chronological model and effort phases" class={timelineList}>
              <For each={chronologicalPhases()}>{(phase) => <PhaseRow detail={props.detail} phase={phase} />}</For>
            </ol>
          </div>
        </Show>
      </section>

      <section aria-labelledby="session-turn-timeline" class={section}>
        <div class={sectionHeader}>
          <h3 class={sectionHeading} id="session-turn-timeline">
            {durationSemantics().timelineHeading}
          </h3>
          <div class={muted}>{durationSemantics().timelineDescription}</div>
        </div>
        <Show
          fallback={<EmptyTimeline>No turn intervals were available in local history.</EmptyTimeline>}
          when={chronologicalTurns().length > 0}
        >
          <div class={timelineShell}>
            <TimelineAxis endedAt={props.detail.endedAt} startedAt={props.detail.startedAt} />
            <ol aria-label="Chronological session turns" class={timelineList}>
              <For each={chronologicalTurns()}>
                {(turn) => <TurnRow detail={props.detail} durationSemantics={durationSemantics()} turn={turn} />}
              </For>
            </ol>
          </div>
        </Show>
      </section>

      <section aria-labelledby="session-prompts" class={section}>
        <div class={sectionHeader}>
          <h3 class={sectionHeading} id="session-prompts">
            Prompts ({chronologicalPrompts().length})
          </h3>
          <div class={muted}>Prompt bodies are collapsed by default.</div>
          <For each={itemsOfKind('privacy')}>{(item) => <PresentationItem item={item} />}</For>
        </div>
        <For each={itemsOfKind('prompt-truncation')}>{(item) => <PresentationItem item={item} />}</For>
        <Show
          fallback={<EmptyTimeline>No prompt text was available in local history.</EmptyTimeline>}
          when={chronologicalPrompts().length > 0}
        >
          <div class={promptList}>
            <For each={chronologicalPrompts()}>
              {(prompt) => (
                <details class={promptDisclosure}>
                  <summary class={promptSummary}>
                    <span aria-hidden="true" class={promptChevron}>
                      ▶
                    </span>
                    <span class={promptPreview}>{promptPreviewText(prompt.text)}</span>
                    <span class={promptSummaryMeta}>
                      <time class={muted} dateTime={prompt.timestamp}>
                        {fmtDateTime(prompt.timestamp)}
                      </time>
                      <Show when={prompt.truncated}>
                        <span class={pill}>Truncated</span>
                      </Show>
                    </span>
                  </summary>
                  <div class={promptBody}>
                    <div class={muted}>
                      <time dateTime={prompt.timestamp}>{fmtDateTime(prompt.timestamp)}</time>
                    </div>
                    {prompt.text}
                  </div>
                </details>
              )}
            </For>
          </div>
        </Show>
        <div class={muted}>
          Detail observed <time dateTime={props.detail.observedAt}>{fmtDateTime(props.detail.observedAt)}</time> from
          local history.
        </div>
      </section>
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
  <div aria-busy={props.busy} aria-live={props.busy ? 'polite' : undefined} class={statePanel}>
    <div class={stateTitle}>{props.title}</div>
    <div>{props.message}</div>
    <Show when={props.actionLabel && props.onAction}>
      <button class={retryButton} onClick={() => props.onAction?.()} type="button">
        {props.actionLabel}
      </button>
    </Show>
  </div>
);

const unavailableTitle = (response: Extract<SessionDetailResponse, { status: 'unavailable' }>): string => {
  if (response.reason === 'not-local') {
    return 'Local history required';
  }
  if (response.reason === 'history-unavailable') {
    return 'Local history unavailable';
  }
  if (response.reason === 'unsupported') {
    return 'Analysis not supported';
  }
  return 'Session detail not found';
};

export const SessionAnalysis = (props: SessionAnalysisProps) => {
  const unavailable = createMemo(() => (props.response?.status === 'unavailable' ? props.response : null));
  const available = createMemo(() => (props.response?.status === 'available' ? props.response : null));

  return (
    <section aria-label="Session analysis" class={panel}>
      <Switch>
        <Match when={props.error}>
          {(message) => (
            <div role="alert">
              <StatePanel actionLabel="Retry" message={message()} onAction={props.onRetry} title="Analysis failed" />
            </div>
          )}
        </Match>
        <Match when={props.loading}>
          <StatePanel busy message="Reading the bounded local session trace…" title="Loading session analysis" />
        </Match>
        <Match when={unavailable()}>
          {(response) => (
            <StatePanel
              actionLabel={props.onRetry ? 'Retry' : undefined}
              message={response().message}
              onAction={props.onRetry}
              title={unavailableTitle(response())}
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
