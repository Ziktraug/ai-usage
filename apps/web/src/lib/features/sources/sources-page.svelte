<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { meta, page, panel, shell } from '@ai-usage/design-system/svelte';
  import type { CollectionSourceGroup, SourceControlCommand } from '@ai-usage/report-core/source-control';
  import { onDestroy } from 'svelte';
  import { fmtDate, fmtNum } from '../../foundation/presentation/format';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import { useSourceControl } from './context.svelte';
  import { createCopyFeedback, registerCopyFeedbackDisposal } from './copy-feedback';
  import { noSessionInputDetected, sessionHistoryLocations } from './first-run';
  import {
    compactRevision,
    conciseSourceStatus,
    deviationSources,
    healthySources,
    orderedSources,
    sourcesInGroup,
  } from './model';
  import { presentSourceState, sourceToneClass } from './presentation';
  import {
    pendingPublishRequests,
    publicationOutcomeLabel,
    publicationStatus,
    rtkDependencyStatus,
  } from './publication-status';
  import ReplicationStatus from './replication-status.svelte';
  import SourceActions from './source-actions.svelte';
  import SourceCard from './source-card.svelte';
  import { actionRow, banner, bannerError, ghostButton, statusPill } from './styles';

  const sourceControl = useSourceControl();
  const controlState = $derived(sourceControl.state());
  const snapshot = $derived(controlState.snapshot);
  const pending = $derived(controlState.pendingCommand !== null);
  const controlsAvailable = $derived(controlState.connection === 'live');
  const liveSources = $derived(orderedSources(controlState));
  const healthy = $derived(healthySources(liveSources));
  const deviations = $derived(deviationSources(liveSources));
  const firstRun = $derived(noSessionInputDetected(liveSources));
  let copiedRevision: string | undefined = $state();
  const copyFeedback = createCopyFeedback(
    {
      cancel: (handle) => window.clearTimeout(handle),
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    },
    (revision) => {
      copiedRevision = revision;
    },
  );
  registerCopyFeedbackDisposal(onDestroy, copyFeedback);

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
      copyFeedback.show(revision);
    } catch {
      copyFeedback.clear();
    }
  };

  const pageStack = css({ display: 'grid', gap: '28px', minW: 0 });
  const groupStack = css({ display: 'grid', gap: '4px', minW: 0 });
  const groupHeader = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' });
  const groupTitle = css({ fontSize: '15px', fontWeight: 600, letterSpacing: '-0.02em' });
  const sourceGrid = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: 0,
  });
  const sourceCard = css({ display: 'grid', gap: '14px', minW: 0, p: { base: '18px', md: '22px 24px' } });
  const publicationCard = css({ borderLeft: '2px solid token(colors.accent)', bg: 'accentTint' });
  const statusLine = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 20px',
    alignItems: 'center',
    pb: '16px',
    borderBottom: '1px solid token(colors.line)',
  });
  const statusCount = css({ color: 'ink', fontFamily: 'mono', fontWeight: 500 });
  const historyLocations = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
    gap: '16px',
  });
  const axes = css({
    display: 'grid',
    gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
    gap: '12px 20px',
    pt: '14px',
  });
  const axis = css({ display: 'grid', gap: '3px', minW: 0 });
  const axisLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
  const axisValue = css({ fontSize: '12px', overflowWrap: 'anywhere' });
  const revisionValue = css({ display: 'flex', alignItems: 'center', gap: '6px', minW: 0 });
  const revisionCode = css({ overflow: 'hidden', fontFamily: 'mono', fontSize: '11px', textOverflow: 'ellipsis' });
  const healthySummary = css({
    overflow: 'hidden',
    borderTop: '1px solid token(colors.line)',
    borderBottom: '1px solid token(colors.line)',
    minW: 0,
  });
  const healthySummaryHeader = css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    p: '16px 0',
    minH: '56px',
    cursor: 'pointer',
  });
  const healthyList = css({ display: 'grid', borderTop: '1px solid token(colors.line)' });
  const healthyRow = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) auto auto' },
    gap: '8px 12px',
    alignItems: 'center',
    p: '14px 0',
    '& + &': { borderTop: '1px solid token(colors.line)' },
  });
  const healthyName = css({ display: 'grid', gap: '3px', minW: 0 });
  const sourceName = css({ fontSize: '14px', fontWeight: 700, overflowWrap: 'anywhere' });
  const sourceId = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  const detailsSummary = css({ color: 'muted', fontSize: '12px', fontWeight: 650, cursor: 'pointer' });
</script>

<main class={page} data-hydrated={controlState.connection === 'stopped' ? 'false' : 'true'} data-route-shell="sources">
  <div class={shell}>
    <WorkspaceHeader description="A clear view of what feeds your report." eyebrow="Local collection" heading="Sources">
      {#snippet actions()}
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
      {/snippet}
    </WorkspaceHeader>
    <div aria-atomic="true" aria-live="polite" class={cx(meta, css({ mb: '16px' }))} role="status">
      {conciseSourceStatus(controlState)}
    </div>
    <div class={pageStack}>
      {#if controlState.connection === 'disconnected'}
        <div class={banner}>Connection interrupted. Showing the last server snapshot while reconnecting.</div>
      {/if}
      {#if controlState.commandError}
        <div class={cx(banner, bannerError)}>{controlState.commandError}</div>
      {/if}
      {#if snapshot}
        {@const rtk = rtkDependencyStatus(snapshot.publication)}
        <section aria-label="Collection activity" class={cx(meta, statusLine)}>
          <span><strong class={statusCount}>{fmtNum(snapshot.runningCount)}</strong> running</span>
          <span><strong class={statusCount}>{fmtNum(snapshot.queueDepth)}</strong> queued</span>
          <span><strong class={statusCount}>{fmtNum(healthy.length)}</strong> healthy sources</span>
          <span>Snapshot {fmtDate(snapshot.generatedAt)}</span>
        </section>
        <section class={cx(panel, sourceCard, publicationCard)}>
          <h2 class={groupTitle}>Report publishing</h2>
          <p class={meta} data-publication-status>{publicationStatus(snapshot.publication)}</p>
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
                <span class={axisLabel}>Last publish</span
                ><span class={axisValue} data-publication-outcome={snapshot.publication.lastOutcome}
                  >{publicationOutcomeLabel(snapshot.publication)}
                  {snapshot.publication.lastPublishedAt ? ` · ${fmtDate(snapshot.publication.lastPublishedAt)}` : ''}</span
                >
              </div>
              <div class={axis}>
                <span class={axisLabel}>Pending publish requests</span
                ><span
                  class={axisValue}
                  data-publication-pending-requests
                  title={`Requested generation ${snapshot.publication.requestedGeneration}, acknowledged ${snapshot.publication.acknowledgedRequestGeneration}`}
                  >{fmtNum(pendingPublishRequests(snapshot.publication))}</span
                >
              </div>
              <div class={axis}>
                <span class={axisLabel}>RTK savings enrichment</span
                ><span class={axisValue} data-publication-rtk={rtk.behind ? 'behind' : 'up-to-date'} title={rtk.title}
                  >{rtk.label}</span
                >
              </div>
            </div>
          </details>
        </section>
        <ReplicationStatus />
        {#if firstRun}
          <section class={cx(panel, sourceCard)} data-first-run-guidance>
            <h2 class={groupTitle}>No local history detected yet</h2>
            <p class={meta}>
              ai-usage reads the session history that installed coding tools write on this machine. Use one of these
              tools once, then run Detect all. Once a source is detected, scheduled collection keeps it up to date.
            </p>
            <div class={historyLocations}>
              {#each sessionHistoryLocations as location (location.harness)}
                <div class={axis} data-first-run-harness>
                  <span class={axisLabel}>{location.harness}</span>
                  {#each location.paths as path (path)}
                    <code class={axisValue}>{path}</code>
                  {/each}
                </div>
              {/each}
            </div>
            <p class={meta}>
              Usage from another machine? Export it there, then import the file on the Sync page — nothing has to be
              collected locally for it to appear in the report.
            </p>
            <div class={actionRow}>
              <button
                class={ghostButton}
                disabled={!controlsAvailable || pending}
                onclick={() => executeCommand({ command: 'detect-all' })}
                type="button"
              >
                Detect all
              </button>
              <a class={ghostButton} href="/sync">Open Sync</a>
            </div>
          </section>
        {/if}
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
        <details class={healthySummary} data-healthy-source-summary>
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
      {:else}
        <div class={panel}>Connecting to the source control plane…</div>
      {/if}
    </div>
  </div>
</main>
