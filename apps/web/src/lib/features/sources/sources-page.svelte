<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { header, meta, page, panel, shell, title, titleBlock } from '@ai-usage/design-system/svelte';
  import type { CollectionSourceGroup, SourceControlCommand } from '@ai-usage/report-core/source-control';
  import { fmtDate, fmtNum } from '../../foundation/presentation/format';
  import { useSourceControl } from './context.svelte';
  import {
    compactRevision,
    conciseSourceStatus,
    deviationSources,
    healthySources,
    orderedSources,
    publicationStatus,
    sourcesInGroup,
  } from './model';
  import { presentSourceState, sourceToneClass } from './presentation';
  import SourceActions from './source-actions.svelte';
  import SourceCard from './source-card.svelte';
  import { banner, bannerError, ghostButton, headerActions, headerTop, statusPill } from './styles';

  const sourceControl = useSourceControl();
  const state = $derived(sourceControl.state());
  const snapshot = $derived(state.snapshot);
  const pending = $derived(state.pendingCommand !== null);
  const controlsAvailable = $derived(state.connection === 'live');
  const liveSources = $derived(orderedSources(state));
  const healthy = $derived(healthySources(liveSources));
  const deviations = $derived(deviationSources(liveSources));
  let copiedRevision: string | undefined = $state();

  const groupOrder: readonly CollectionSourceGroup[] = ['sessions', 'provider-usage', 'enrichments'];
  const groupLabels: Record<CollectionSourceGroup, string> = {
    enrichments: 'Enrichments',
    'provider-usage': 'Provider usage',
    sessions: 'Sessions',
  };
  const sourceCountLabel = (count: number): string => `${fmtNum(count)} source${count === 1 ? '' : 's'}`;
  const executeCommand = (command: SourceControlCommand): void => {
    sourceControl.execute(command).catch(() => undefined);
  };

  const copyRevision = async (revision: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(revision);
      copiedRevision = revision;
      window.setTimeout(() => {
        if (copiedRevision === revision) {
          copiedRevision = undefined;
        }
      }, 1500);
    } catch {
      copiedRevision = undefined;
    }
  };

  const pageStack = css({ display: 'grid', gap: '18px' });
  const groupStack = css({ display: 'grid', gap: '10px' });
  const groupHeader = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' });
  const groupTitle = css({ fontSize: '16px', fontWeight: 700 });
  const sourceGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
    gap: '12px',
  });
  const sourceCard = css({ display: 'grid', gap: '14px', minW: 0 });
  const axes = css({
    display: 'grid',
    gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
    gap: '8px',
  });
  const axis = css({ display: 'grid', gap: '3px', minW: 0 });
  const axisLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
  const axisValue = css({ fontSize: '12px', overflowWrap: 'anywhere' });
  const revisionValue = css({ display: 'flex', alignItems: 'center', gap: '6px', minW: 0 });
  const revisionCode = css({ overflow: 'hidden', fontFamily: 'mono', fontSize: '11px', textOverflow: 'ellipsis' });
  const healthySummary = css({ overflow: 'hidden' });
  const healthySummaryHeader = css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    p: '14px 16px',
    cursor: 'pointer',
  });
  const healthyList = css({ display: 'grid', borderTop: '1px solid token(colors.line)' });
  const healthyRow = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) auto auto' },
    gap: '8px 12px',
    alignItems: 'center',
    p: '12px 16px',
    '& + &': { borderTop: '1px solid token(colors.line)' },
  });
  const healthyName = css({ display: 'grid', gap: '3px', minW: 0 });
  const sourceName = css({ fontSize: '14px', fontWeight: 700, overflowWrap: 'anywhere' });
  const sourceId = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  const detailsSummary = css({ color: 'muted', fontSize: '12px', fontWeight: 650, cursor: 'pointer' });
</script>

<main class={page} data-hydrated={state.connection === 'stopped' ? 'false' : 'true'}>
  <div class={shell}>
    <header class={header}>
      <div class={headerTop}>
        <div class={titleBlock}>
          <p class={meta}>Server-owned collection</p>
          <h1 class={title}>Sources</h1>
          <p class={meta}>Policy, availability, lifecycle, and outcomes stay independent for every collector.</p>
        </div>
        <div class={headerActions}>
          <button
            class={ghostButton}
            disabled={!(snapshot && controlsAvailable) || pending}
            onclick={() => executeCommand({ command: 'detect-all' })}
            type="button"
          >
            Detect all
          </button>
          <button
            class={ghostButton}
            disabled={!(snapshot && controlsAvailable) || pending}
            onclick={() => executeCommand({ command: 'run-all' })}
            type="button"
          >
            Run all enabled
          </button>
        </div>
      </div>
    </header>
    <div aria-atomic="true" aria-live="polite" class={meta} role="status">{conciseSourceStatus(state)}</div>
    <div class={pageStack}>
      {#if state.connection === 'disconnected'}
        <div class={banner}>Connection interrupted. Showing the last server snapshot while reconnecting.</div>
      {/if}
      {#if state.commandError}
        <div class={cx(banner, bannerError)}>{state.commandError}</div>
      {/if}
      {#if snapshot}
        <p class={meta}>
          {fmtNum(snapshot.runningCount)}
          running · {fmtNum(snapshot.queueDepth)} queued · snapshot {fmtDate(snapshot.generatedAt)}
        </p>
        <section class={cx(panel, sourceCard)}>
          <h2 class={groupTitle}>Report publication pipeline</h2>
          <p class={meta}>{publicationStatus(snapshot.publication)}</p>
          <details data-publication-details>
            <summary class={detailsSummary}>Details</summary>
            <div class={axes}>
              <div class={axis}>
                <span class={axisLabel}>Revision</span>
                {#if snapshot.publication.revision}
                  <div class={revisionValue}>
                    <code class={revisionCode} title={snapshot.publication.revision}
                      >{compactRevision(snapshot.publication.revision)}</code
                    >
                    <button
                      aria-label="Copy publication revision"
                      class={ghostButton}
                      onclick={() => copyRevision(snapshot.publication.revision ?? '').catch(() => undefined)}
                      type="button"
                    >
                      {copiedRevision === snapshot.publication.revision ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                {:else}
                  <span class={axisValue}>Not published yet</span>
                {/if}
              </div>
              <div class={axis}>
                <span class={axisLabel}>Last outcome</span
                ><span class={axisValue}>{snapshot.publication.lastOutcome}</span>
              </div>
              <div class={axis}>
                <span class={axisLabel}>Demand</span
                ><span class={axisValue}
                  >{snapshot.publication.acknowledgedRequestGeneration}/{snapshot.publication.requestedGeneration}
                  acknowledged</span
                >
              </div>
              <div class={axis}>
                <span class={axisLabel}>RTK dependency</span
                ><span class={axisValue}
                  >{snapshot.publication.rtkCompletedGeneration >= snapshot.publication.rtkRequiredGeneration ? 'Caught up' : `Waiting for generation ${snapshot.publication.rtkRequiredGeneration}`}</span
                >
              </div>
            </div>
          </details>
        </section>
        <details class={cx(panel, healthySummary)} data-healthy-source-summary>
          <summary class={healthySummaryHeader}>
            <h2 class={groupTitle}>Healthy sources</h2>
            <span class={cx(statusPill, sourceToneClass('ok'))}>{sourceCountLabel(healthy.length)}</span>
          </summary>
          <div class={healthyList}>
            {#each healthy as source (source.id)}
              {@const presentation = presentSourceState(source)}
              <div class={healthyRow} data-healthy-source-row>
                <div class={healthyName}>
                  <h3 class={sourceName}>{source.label}</h3>
                  <p class={sourceId}>{source.id}</p>
                  {#if source.progress}
                    <span class={meta}
                      >{source.progress.phase}{source.progress.message ? ` · ${source.progress.message}` : ''}</span
                    >
                  {/if}
                </div>
                <span class={cx(statusPill, sourceToneClass(presentation.tone))} data-source-health
                  >{presentation.label}</span
                >
                <SourceActions available={controlsAvailable} execute={sourceControl.execute} {pending} {source} />
              </div>
            {/each}
          </div>
        </details>
        {#each groupOrder as group (group)}
          {@const grouped = sourcesInGroup(deviations, group)}
          {#if grouped.length > 0}
            <section aria-labelledby={`source-group-${group}`} class={groupStack}>
              <div class={groupHeader}>
                <h2 class={groupTitle} id={`source-group-${group}`}>{groupLabels[group]}</h2>
                <span class={meta}>{sourceCountLabel(grouped.length)}</span>
              </div>
              <div class={sourceGrid}>
                {#each grouped as source (source.id)}
                  <SourceCard available={controlsAvailable} execute={sourceControl.execute} {pending} {source} />
                {/each}
              </div>
            </section>
          {/if}
        {/each}
      {:else}
        <div class={panel}>Connecting to the source control plane…</div>
      {/if}
    </div>
  </div>
</main>
