<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed boolean ARIA values asserted by SSR -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

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
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(220px, 0.42fr) minmax(0, 1fr) minmax(72px, 0.16fr)' },
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
  const axisTrack = css({ display: 'grid', gap: '2px', minW: 0 });
  const axisBreaks = css({ position: 'relative', h: '14px', minW: 0 });
  const axisTokenHeading = css({
    display: { base: 'none', md: 'block' },
    color: 'faint',
    fontSize: '10px',
    fontWeight: 650,
  });
  const scaleBreakClass = css({
    position: 'absolute',
    top: 0,
    color: 'ink',
    fontSize: '14px',
    fontWeight: 700,
    lineHeight: 1,
    transform: 'translateX(-50%)',
  });
  const timelineList = css({ display: 'grid', gap: '7px', listStyle: 'none', m: 0, p: 0 });
  const timelineRow = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(220px, 0.42fr) minmax(0, 1fr) minmax(72px, 0.16fr)' },
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
  const timelineBar = css({ position: 'absolute', top: '3px', bottom: '3px', borderRadius: '4px' });
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
  const phaseDot = css({ display: 'inline-block', flex: '0 0 auto', w: '8px', h: '8px', borderRadius: 'full' });
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
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SessionDetailPhase, SessionDetailResponse } from '@ai-usage/report-core/session-detail';
  import type { SessionAnalysisError } from '../../../../session-analysis-error';
  import {
    buildSessionTimelineRows,
    buildTimelineScale,
    countActivityBursts,
    countLabel,
    formatSessionDuration,
    phaseTokenShare,
    positionOnScale,
    type SessionTimelineRow,
    sessionDurationCaption,
    sessionDurationSemantics,
    type TimelineScaleMode,
    timelineHasCompressibleGaps,
  } from '../../../../session-analysis-model';
  import { buildSessionAnalysisPresentation } from '../../../../session-analysis-presentation';
  import type { SessionAnalysisTarget } from '../../../../session-analysis-target';

  let {
    error: analysisError = null,
    harnessKey,
    loading,
    onRetry,
    response,
    target,
  }: {
    error?: SessionAnalysisError | null;
    harnessKey: string;
    loading: boolean;
    onRetry?: () => void;
    response: SessionDetailResponse | null;
    target: SessionAnalysisTarget;
  } = $props();

  const PROMPT_PREVIEW_CHARACTER_LIMIT = 120;
  const INTEGER_PERCENT_THRESHOLD = 10;
  const SUB_DOLLAR_THRESHOLD = 1;
  const MULTIPLE_PHASE_THRESHOLD = 2;
  const FULL_PERCENT = 100;

  const dateTimeFormatter = new Intl.DateTimeFormat('en', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: 'short',
  });
  const compactNumberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' });
  const moneyFormatter = new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  });
  const subDollarFormatter = new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
    style: 'currency',
  });
  const fmtDateTime = (value: string): string => dateTimeFormatter.format(new Date(value));
  const fmtTokens = (value: number): string => compactNumberFormatter.format(value);
  const fmtCount = (count: number, noun: string): string => `${fmtTokens(count)} ${count === 1 ? noun : `${noun}s`}`;
  const fmtShare = (share: number): string =>
    `${share >= INTEGER_PERCENT_THRESHOLD ? share.toFixed(0) : share.toFixed(1)}%`;
  const fmtEffort = (phase: Pick<SessionDetailPhase, 'effort' | 'effortKind'>): string =>
    phase.effort ?? (phase.effortKind === 'default' ? 'default effort' : 'effort not recorded');
  const formatCost = (phase: SessionDetailPhase): string => {
    if (phase.cost === null) {
      return 'price unknown';
    }
    const value = (phase.cost >= SUB_DOLLAR_THRESHOLD ? moneyFormatter : subDollarFormatter).format(phase.cost);
    return phase.costKind === 'approximate' ? `≈ ${value}` : `${value} reported`;
  };
  const phaseKey = (phase: SessionDetailPhase): string => `${phase.model}\0${phase.effortKind}\0${phase.effort ?? ''}`;
  const phaseRenderKey = (phase: SessionDetailPhase, index: number): string =>
    `${phaseKey(phase)}\0${phase.startAt}\0${phase.endAt}\0${index}`;
  const phaseToneIndex = (phase: SessionDetailPhase, phases: readonly SessionDetailPhase[]): number =>
    Math.max(0, [...new Set(phases.map(phaseKey))].indexOf(phaseKey(phase))) % phaseToneClasses.length;
  const phaseTone = (phase: SessionDetailPhase, phases: readonly SessionDetailPhase[]): string =>
    phaseToneClasses[phaseToneIndex(phase, phases)] ?? phaseToneClasses[0];
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
  const preview = (text: string): string => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > PROMPT_PREVIEW_CHARACTER_LIMIT
      ? `${normalized.slice(0, PROMPT_PREVIEW_CHARACTER_LIMIT).trimEnd()}…`
      : normalized;
  };
  const unavailableTitles = {
    'history-unavailable': 'Local history unavailable',
    'not-found': 'Local session history not found',
    'not-local': 'Local history required',
    'report-provenance-unavailable': 'Session provenance unavailable',
    'report-row-not-found': 'Session not found in report',
    'revision-expired': 'Report revision expired',
    unsupported: 'Analysis not supported',
  } as const;
  const available = $derived(response?.status === 'available' ? response : null);
  const unavailable = $derived(response?.status === 'unavailable' ? response : null);
  const liveAnnouncementFor = (): string => {
    if (analysisError) {
      return '';
    }
    if (loading) {
      return 'Loading session analysis';
    }
    if (unavailable) {
      return `${unavailableTitles[unavailable.reason]}. ${unavailable.message}`;
    }
    return available ? 'Session analysis loaded' : '';
  };
  const liveAnnouncement = $derived(liveAnnouncementFor());
  let scaleMode = $state<TimelineScaleMode>('compressed');
  const detail = $derived(available?.detail ?? null);
  const chronologicalPhases = $derived(
    detail ? [...detail.phases].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)) : [],
  );
  const dominantPhase = $derived(
    chronologicalPhases.reduce<SessionDetailPhase | null>(
      (dominant, phase) => (!dominant || phase.tokens.total > dominant.tokens.total ? phase : dominant),
      null,
    ),
  );
  const timelineRows = $derived(detail ? buildSessionTimelineRows(detail) : []);
  const durationSemantics = $derived(sessionDurationSemantics(harnessKey, target.kind === 'campaign-root'));
  const burstCount = $derived(detail ? countActivityBursts(detail.turns) : 0);
  const durationParts = $derived(detail ? sessionDurationCaption(detail, durationSemantics, burstCount) : []);
  const presentationItems = $derived(
    available
      ? buildSessionAnalysisPresentation({
          consistency: available.consistency,
          durationPartialBody: durationSemantics.partialBody,
          durationStatus: available.detail.durationStatus,
          promptDataTruncated:
            available.detail.promptsTruncated || available.detail.prompts.some((prompt) => prompt.truncated),
          target,
          turnsStatus: available.detail.turnsStatus,
        })
      : [],
  );
  const items = (kind: (typeof presentationItems)[number]['kind']) =>
    presentationItems.filter((item) => item.kind === kind);
  const scale = $derived(detail ? buildTimelineScale(detail, scaleMode) : null);
  const hasCompressibleGaps = $derived(detail ? timelineHasCompressibleGaps(detail) : false);
  const rowLabel = (row: Extract<SessionTimelineRow, { kind: 'task' }>): string =>
    preview(row.prompts[0]?.text ?? '') || `${durationSemantics.rowNoun} ${row.index + 1}`;
  const rowDuration = (row: Extract<SessionTimelineRow, { kind: 'task' }>): string =>
    row.durationMs === null ? 'Recorded duration unavailable' : formatSessionDuration(row.durationMs);
  const taskBounds = (
    row: Extract<SessionTimelineRow, { kind: 'task' }>,
  ): { readonly endAt: string; readonly startAt: string } | null => {
    const intervals = [...row.intervals].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
    const first = intervals[0];
    if (!first) {
      return null;
    }
    const endAt = intervals.reduce(
      (latest, interval) => (Date.parse(interval.endAt) > Date.parse(latest) ? interval.endAt : latest),
      first.endAt,
    );
    return { endAt, startAt: first.startAt };
  };
  const taskTone = (row: Extract<SessionTimelineRow, { kind: 'task' }>): number | undefined => {
    if (chronologicalPhases.length < MULTIPLE_PHASE_THRESHOLD) {
      return;
    }
    const phase = phaseAt(chronologicalPhases, taskBounds(row)?.startAt ?? row.startAt);
    return phase ? phaseToneIndex(phase, chronologicalPhases) : undefined;
  };
  const showTaskPhaseMeta = (row: Extract<SessionTimelineRow, { kind: 'task' }>): boolean =>
    chronologicalPhases.length >= MULTIPLE_PHASE_THRESHOLD &&
    (!dominantPhase ||
      row.model !== dominantPhase.model ||
      row.effort !== dominantPhase.effort ||
      row.effortKind !== dominantPhase.effortKind);
  const taskAccessibleLabel = (row: Extract<SessionTimelineRow, { kind: 'task' }>, label: string): string => {
    const bounds = taskBounds(row);
    const timeBounds = bounds
      ? `, from ${fmtDateTime(bounds.startAt)} to ${fmtDateTime(bounds.endAt)}`
      : `, point event at ${fmtDateTime(row.startAt)}; recorded active time bounds unavailable`;
    return `${label}, ${row.model}, ${fmtEffort(row)}, ${rowDuration(row)} across ${countLabel(row.intervals.length, 'segment')}, ${countLabel(row.tokens.total, 'token')}, ${countLabel(row.tools, 'tool')} and ${countLabel(row.prompts.length, 'prompt')}${timeBounds}`;
  };
  const boundPrefix = (bound: 'lower' | 'upper' | null): string => {
    if (bound === 'lower') {
      return '≥ ';
    }
    return bound === 'upper' ? '≤ ' : '';
  };
  const stateTitleFor = (): string => {
    if (analysisError) {
      return analysisError.kind === 'transient' ? 'Analysis failed' : 'Analysis unavailable';
    }
    return unavailable ? unavailableTitles[unavailable.reason] : 'No analysis loaded';
  };
  const stateTitle = $derived(stateTitleFor());
  const stateMessage = $derived(
    analysisError?.message ?? unavailable?.message ?? 'Select a locally recorded session to inspect its timeline.',
  );
  const canRetry = $derived(
    Boolean(onRetry && (analysisError?.kind === 'transient' || unavailable?.reason === 'history-unavailable')),
  );
</script>

{#snippet renderTimelineAxis(_showTokens: boolean)}
  {#if detail && scale}
    <div class={timelineAxis}>
      <span aria-hidden="true" class={timelineAxisSpacer}></span>
      <div class={axisTrack}>
        <div class={axisLabels} data-session-analysis-axis-labels>
          <time datetime={detail.startedAt}>{fmtDateTime(detail.startedAt)}</time>
          <span aria-hidden="true">{scaleMode === 'compressed' ? 'Compressed gaps' : 'Wall-clock time'}</span>
          <time datetime={detail.endedAt}>{fmtDateTime(detail.endedAt)}</time>
        </div>
        {#if scale.breaks.length > 0}
          <div aria-hidden="true" class={axisBreaks} data-session-analysis-axis-breaks>
            {#each scale.breaks as scaleBreak (scaleBreak.atPercent)}
              <span
                aria-hidden="true"
                class={scaleBreakClass}
                title={formatSessionDuration(scaleBreak.gapMs)}
                style:left={`${scaleBreak.atPercent}%`}
                >⫽</span
              >
            {/each}
          </div>
        {/if}
      </div>
      <span class={axisTokenHeading}>{_showTokens ? 'Tokens' : ''}</span>
    </div>
  {/if}
{/snippet}

<section aria-label="Session analysis" class={panel}>
  <div aria-atomic="true" aria-live="polite" class={visuallyHidden} data-session-analysis-live-status role="status">
    {liveAnnouncement}
  </div>
  {#if analysisError}
    <div role="alert">
      <div class={statePanel}>
        <div class={stateTitle}>{stateTitle}</div>
        <div>{stateMessage}</div>
        {#if canRetry}
          <button class={retryButton} onclick={() => onRetry?.()} type="button">Retry</button>
        {/if}
      </div>
    </div>
  {:else if loading}
    <div aria-busy="true" class={statePanel}>
      <div class={stateTitle}>Loading session analysis</div>
      <div>Reading the bounded local session trace…</div>
    </div>
  {:else if unavailable}
    <div class={statePanel}>
      <div class={stateTitle}>{stateTitle}</div>
      <div>{stateMessage}</div>
      {#if canRetry}
        <button class={retryButton} onclick={() => onRetry?.()} type="button">Retry</button>
      {/if}
    </div>
  {:else if available && detail && scale}
    <div class={panel}>
      <header class={header}>
        <h2 class={heading}>Session analysis</h2>
        <div class={muted}>
          <time datetime={detail.startedAt}>{fmtDateTime(detail.startedAt)}</time>
          →
          <time datetime={detail.endedAt}>{fmtDateTime(detail.endedAt)}</time>
          · session
          <span class={numeric}>{detail.sourceSessionId}</span>
        </div>
        {#each items('consistency-meta') as item (item.text)}
          <div class={muted} data-session-analysis-item={item.kind} data-tone={item.tone}>{item.text}</div>
        {/each}
        {#each items('scope') as item (item.text)}
          <div class={muted} data-session-analysis-item={item.kind} data-tone={item.tone}>{item.text}</div>
        {/each}
        {#each items('consistency-warning') as item (item.text)}
          <div
            class={cx(notice, warningNotice)}
            data-session-analysis-item={item.kind}
            data-tone={item.tone}
            role="status"
          >
            {item.text}
          </div>
        {/each}
      </header>

      <section aria-labelledby="session-timeline" class={section}>
        <div class={sectionHeader}>
          <h3 class={sectionHeading} id="session-timeline">{durationSemantics.timelineHeading}</h3>
          <div class={durationCaption}>
            {#each durationParts as part, index (part.key)}
              <span class={durationCaptionPart} data-session-analysis-metric={part.key} title={part.hint}>
                {#if index > 0}
                  ·
                {/if}
                {part.label}
                {#if part.bound}
                  <span class={visuallyHidden}>{part.bound === 'lower' ? 'At least ' : 'At most '}</span>
                  <span aria-hidden="true">{boundPrefix(part.bound)}</span>
                {/if}
                {part.value}
              </span>
            {/each}
          </div>
          {#each items('partial-duration') as item (item.text)}
            <div class={muted} data-session-analysis-item={item.kind} data-tone={item.tone}>{item.text}</div>
          {/each}
          <div class={muted}>{durationSemantics.timelineDescription}</div>
          {#each ['partial-turns', 'privacy', 'prompt-truncation'] as kind}
            {#each items(kind as (typeof presentationItems)[number]['kind']) as item (item.text)}
              <div class={muted} data-session-analysis-item={item.kind} data-tone={item.tone}>{item.text}</div>
            {/each}
          {/each}
          {#if hasCompressibleGaps}
            <button
              aria-label="Show real gaps"
              aria-pressed={scaleMode === 'wall-clock' ? 'true' : 'false'}
              class={scaleButton}
              onclick={() => { scaleMode = scaleMode === 'compressed' ? 'wall-clock' : 'compressed'; }}
              type="button"
            >
              {scaleMode === 'compressed' ? 'Show real gaps' : 'Compress gaps'}
            </button>
          {/if}
        </div>

        {#if timelineRows.length === 0}
          <div class={empty}>
            No turn intervals were available in local history. No prompt text was available in local history.
          </div>
        {:else}
          <div class={timelineShell} data-session-analysis-scale={scaleMode}>
            {@render renderTimelineAxis(true)}
            <ol aria-label="Chronological session tasks and prompts" class={timelineList}>
              {#each timelineRows as row (`${row.kind}:${row.kind === 'task' ? row.index : row.prompt.id}`)}
                {#if row.kind === 'task'}
                  {@const tone = taskTone(row)}
                  {@const label = rowLabel(row)}
                  <li class={timelineRow} data-session-analysis-row="task">
                    <details class={promptDisclosure}>
                      <summary class={promptSummary}>
                        <span aria-hidden="true" class={promptChevron}>▶</span>
                        <span class={promptLabelContent}>
                          <span class={promptTitleRow}>
                            <span class={promptPreview}>{row.prompts[0] ? `Prompt: ${label}` : label}</span>
                            <span class={muted} title={durationSemantics.metricHint}>{rowDuration(row)}</span>
                          </span>
                          <span class={timelineMeta}>
                            {#if showTaskPhaseMeta(row)}
                              {row.model}
                              · {fmtEffort(row)} ·
                            {/if}
                            {fmtCount(row.tokens.total, 'token')}
                            ·
                            {countLabel(row.tools, 'tool')}
                            · {countLabel(row.prompts.length, 'prompt')}
                          </span>
                        </span>
                      </summary>
                      <div class={promptBody}>
                        {#if row.prompts.length === 0}
                          <span class={muted}>No prompt text was available in local history.</span>
                        {/if}
                        {#each row.prompts as prompt (prompt.id)}
                          <div class={promptEntry}>
                            <div class={promptEntryMeta}>
                              <time class={muted} datetime={prompt.timestamp}>{fmtDateTime(prompt.timestamp)}</time>
                              {#if prompt.truncated}
                                <span class={pill}>Truncated</span>
                              {/if}
                            </div>
                            <span>{prompt.text}</span>
                          </div>
                        {/each}
                      </div>
                    </details>
                    <div
                      aria-label={taskAccessibleLabel(row, label)}
                      class={cx(timelineTrack, scaleMode === 'wall-clock' && wallClockTrack)}
                      role="img"
                    >
                      {#each row.intervals as interval (`${interval.startAt}:${interval.endAt}`)}
                        {@const position = positionOnScale(scale, interval.startAt, interval.endAt)}
                        <span
                          aria-hidden="true"
                          class={cx(timelineBar, tone === undefined ? turnBar : phaseToneClasses[tone])}
                          data-session-analysis-phase-tone={tone}
                          style:left={`${position.leftPercent}%`}
                          style:width={`${position.widthPercent}%`}
                        ></span>
                      {/each}
                      {#if row.intervals.length === 0}
                        {@const position = positionOnScale(scale, row.startAt, row.startAt)}
                        <span
                          aria-hidden="true"
                          class={pointMarker}
                          data-session-analysis-point
                          style:left={`${position.leftPercent}%`}
                        ></span>
                      {/if}
                    </div>
                    <div class={tokenCell}>
                      <span aria-hidden="true" class={tokenTrack}
                        ><span class={tokenBar} style:width={`${row.tokenShareOfMax * FULL_PERCENT}%`}></span></span
                      ><span class={tokenValue}>{fmtTokens(row.tokens.total)}</span>
                    </div>
                  </li>
                {:else}
                  {@const label = preview(row.prompt.text) || 'Prompt'}
                  {@const position = positionOnScale(scale, row.prompt.timestamp, row.prompt.timestamp)}
                  <li class={timelineRow} data-session-analysis-row="orphan-prompt">
                    <details class={promptDisclosure}>
                      <summary class={promptSummary}>
                        <span aria-hidden="true" class={promptChevron}>▶</span>
                        <span class={promptLabelContent}>
                          <span class={promptPreview}>Prompt: {label}</span>
                          <time class={timelineMeta} datetime={row.prompt.timestamp}>
                            {fmtDateTime(row.prompt.timestamp)}
                            · prompt without task attribution
                          </time>
                        </span>
                      </summary>
                      <div class={promptBody}>
                        <div class={promptEntry}>
                          <div class={promptEntryMeta}>
                            <time class={muted} datetime={row.prompt.timestamp}
                              >{fmtDateTime(row.prompt.timestamp)}</time
                            >
                            {#if row.prompt.truncated}
                              <span class={pill}>Truncated</span>
                            {/if}
                          </div>
                          <span>{row.prompt.text}</span>
                        </div>
                      </div>
                    </details>
                    <div
                      aria-label={`${label}, orphan prompt, 0s ${durationSemantics.turnSpanNoun}, tokens unavailable, 0 tools, point event with no task attribution, from ${fmtDateTime(row.prompt.timestamp)} to ${fmtDateTime(row.prompt.timestamp)}`}
                      class={cx(timelineTrack, scaleMode === 'wall-clock' && wallClockTrack)}
                      role="img"
                    >
                      <span
                        aria-hidden="true"
                        class={pointMarker}
                        data-session-analysis-point
                        style:left={`${position.leftPercent}%`}
                      ></span>
                    </div>
                    <span class={tokenCell}><span class={tokenValue}>—</span></span>
                  </li>
                {/if}
              {/each}
            </ol>
          </div>
        {/if}
      </section>

      {#if chronologicalPhases.length >= MULTIPLE_PHASE_THRESHOLD}
        <section aria-labelledby="session-model-phases" class={section}>
          <div class={sectionHeader}>
            <h3 class={sectionHeading} id="session-model-phases">Model and effort phases</h3>
            <div class={muted}>
              Band position follows the selected timeline scale; percentages show each phase's token share.
            </div>
          </div>
          <div class={timelineShell}>
            {@render renderTimelineAxis(false)}
            <ol aria-label="Chronological model and effort phases" class={timelineList}>
              {#each chronologicalPhases as phase, index (phaseRenderKey(phase, index))}
                {@const position = positionOnScale(scale, phase.startAt, phase.endAt)}
                {@const share = phaseTokenShare(phase, chronologicalPhases)}
                <li class={timelineRow}>
                  <div class={timelineLabel}>
                    <div class={timelineLabelTop}>
                      <span aria-hidden="true" class={cx(phaseDot, phaseTone(phase, chronologicalPhases))}></span>
                      <span class={timelineLabelText} title={phase.model}>{phase.model}</span>
                    </div>
                    <div class={timelineMeta}>{fmtEffort(phase)} · {fmtShare(share)} tokens · {formatCost(phase)}</div>
                  </div>
                  <div
                    aria-label={`${phase.model}, ${fmtEffort(phase)}, ${fmtShare(share)} of tokens, ${formatCost(phase)}, from ${fmtDateTime(phase.startAt)} to ${fmtDateTime(phase.endAt)}`}
                    class={cx(timelineTrack, scaleMode === 'wall-clock' && wallClockTrack)}
                    role="img"
                  >
                    <span
                      aria-hidden="true"
                      class={cx(timelineBar, phaseTone(phase, chronologicalPhases))}
                      style:left={`${position.leftPercent}%`}
                      style:width={`${position.widthPercent}%`}
                    ></span>
                  </div>
                  <span aria-hidden="true"></span>
                </li>
              {/each}
            </ol>
          </div>
        </section>
      {:else if chronologicalPhases[0]}
        <div class={cx(muted, phaseLegend)}>
          <span aria-hidden="true" class={cx(phaseDot, phaseTone(chronologicalPhases[0], chronologicalPhases))}></span>
          <span
            >{chronologicalPhases[0].model}
            · {fmtEffort(chronologicalPhases[0])} · {FULL_PERCENT}% tokens · {formatCost(chronologicalPhases[0])}</span
          >
        </div>
      {/if}
      <div class={muted}>
        Detail observed <time datetime={detail.observedAt}>{fmtDateTime(detail.observedAt)}</time> from local history.
      </div>
    </div>
  {:else}
    <div class={statePanel}>
      <div class={stateTitle}>No analysis loaded</div>
      <div>{stateMessage}</div>
    </div>
  {/if}
</section>
