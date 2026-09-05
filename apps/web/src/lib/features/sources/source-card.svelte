<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { meta, panel } from '@ai-usage/design-system/svelte';
  import type { SourceControlCommand, SourceControlEntryView } from '@ai-usage/report-core/source-control';
  import { fmtDate, fmtNum } from '../../foundation/presentation/format';
  import { presentSourceProgress, presentSourceState, sourceToneClass } from './presentation';
  import SourceActions from './source-actions.svelte';
  import { statusPill } from './styles';

  let {
    available,
    execute,
    pending,
    source,
  }: {
    available: boolean;
    execute: (command: SourceControlCommand) => Promise<boolean>;
    pending: boolean;
    source: SourceControlEntryView;
  } = $props();

  const presentation = $derived(presentSourceState(source));
  const progress = $derived(presentSourceProgress(source));

  const sourceCard = css({ display: 'grid', gap: '14px', minW: 0 });
  const sourceHeader = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '12px',
    alignItems: 'start',
  });
  const sourceName = css({ fontSize: '14px', fontWeight: 700, overflowWrap: 'anywhere' });
  const sourceId = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  const axes = css({
    display: 'grid',
    gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
    gap: '8px',
  });
  const axis = css({ display: 'grid', gap: '3px', minW: 0 });
  const axisLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
  const axisValue = css({ fontSize: '12px', overflowWrap: 'anywhere' });
  const detailList = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '12px', lineHeight: 1.5 });
  // Outcome and the next action lead; cadence, timings and counters are what an operator opens when
  // a run looks wrong, not what they read to know whether it did.
  const runDetails = css({
    color: 'muted',
    fontSize: '12px',
    '& > summary': { cursor: 'pointer', fontWeight: 650, color: 'ink' },
    '&[open] > summary': { mb: '6px' },
  });
  const progressStack = css({ display: 'grid', gap: '5px' });
  const progressBar = css({ width: '100%', accentColor: 'accent' });
</script>

<article class={cx(panel, sourceCard)} data-source-card>
  <div class={sourceHeader}>
    <div>
      <h3 class={sourceName}>{source.label}</h3>
      <p class={sourceId}>{source.id}</p>
    </div>
    <span class={cx(statusPill, sourceToneClass(presentation.tone))} data-source-health>
      {presentation.label}
    </span>
  </div>
  <div class={axes}>
    <div class={axis}>
      <span class={axisLabel}>Availability</span><span class={axisValue}>{source.availability}</span>
    </div>
    <div class={axis}><span class={axisLabel}>Lifecycle</span><span class={axisValue}>{source.lifecycle}</span></div>
    <div class={axis}>
      <span class={axisLabel}>Last outcome</span><span class={axisValue}>{source.lastOutcome}</span>
    </div>
    <div class={axis}>
      <span class={axisLabel}>Last success</span><span class={axisValue}>{fmtDate(source.lastSuccessAt ?? null)}</span>
    </div>
  </div>
  {#if source.progress}
    <div class={progressStack}>
      <span class={meta}>
        {source.progress.phase}{source.progress.message ? ` · ${source.progress.message}` : ''}
      </span>
      {#if progress.kind === 'determinate'}
        <progress
          aria-label={`${source.label} progress`}
          class={progressBar}
          max={progress.max}
          value={progress.value}
        ></progress>
      {:else}
        <progress aria-label={`${source.label} progress`} class={progressBar}></progress>
      {/if}
    </div>
  {/if}
  <div class={detailList}>
    {#if source.reason.code !== 'none'}
      <p>Reason: {source.reason.message ?? source.reason.code}</p>
    {/if}
    {#each source.warnings as warning (`${warning.code}:${warning.message ?? ''}`)}
      <p>Warning: {warning.message ?? warning.code}</p>
    {/each}
  </div>
  <details class={runDetails} data-source-run-details>
    <summary>Run details</summary>
    <div class={detailList}>
      <p>Next due {fmtDate(source.nextDueAt ?? null)}</p>
      {#if source.inputCount !== undefined || source.outputCount !== undefined}
        <p>Last run: {fmtNum(source.inputCount ?? 0)} inputs · {fmtNum(source.outputCount ?? 0)} outputs</p>
      {/if}
      <p>
        Cadence: {fmtNum(Math.round(source.cadenceMs / 1000))}s · duration
        {source.durationMs === undefined ? 'not available' : `${fmtNum(source.durationMs)}ms`}
        · queue delay
        {source.queueDelayMs === undefined ? 'not available' : `${fmtNum(source.queueDelayMs)}ms`}
      </p>
      <p>Started {fmtDate(source.lastStartedAt ?? null)} · finished {fmtDate(source.lastFinishedAt ?? null)}</p>
    </div>
  </details>
  <SourceActions {available} {execute} {pending} {source} />
</article>
