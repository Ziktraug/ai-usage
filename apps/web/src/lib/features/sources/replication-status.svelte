<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { meta, panel } from '@ai-usage/design-system/svelte';
  import { browser } from '$app/environment';
  import { fmtDate, fmtNum } from '../../foundation/presentation/format';
  import { sourceToneClass } from './presentation';
  import { createReplicationStatusQuery } from './replication-query.svelte';
  import {
    presentReplicationStatus,
    presentReplicationStream,
    replicationDiagnosticLabel,
  } from './replication-status-model';
  import { ghostButton, statusPill } from './styles';

  const statusQuery = createReplicationStatusQuery(browser);
  const status = $derived(statusQuery.data);
  const presentation = $derived(status ? presentReplicationStatus(status) : undefined);
  const diagnostic = $derived(status ? replicationDiagnosticLabel(status.lastDiagnostic) : undefined);
  const streams = $derived(
    status?.mode === 'connected'
      ? [
          { label: 'Usage', status: status.usage },
          { label: 'Memory', status: status.memory },
        ]
      : [],
  );

  const card = css({ display: 'grid', gap: '14px', minW: 0 });
  const top = css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '12px' });
  const titleGroup = css({ display: 'grid', gap: '4px', minW: 0 });
  const sectionTitle = css({ fontSize: '16px', fontWeight: 700 });
  const streamGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
    gap: '10px',
  });
  const streamCard = css({
    display: 'grid',
    gap: '10px',
    p: '12px',
    minW: 0,
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
  });
  const streamTop = css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' });
  const streamTitle = css({ fontSize: '13px', fontWeight: 700 });
  const facts = css({
    display: 'grid',
    gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
    gap: '8px',
  });
  const fact = css({ display: 'grid', gap: '2px', minW: 0 });
  const factLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
  const factValue = css({ fontSize: '12px', overflowWrap: 'anywhere' });
</script>

<section aria-labelledby="device-replication-title" class={cx(panel, card)} data-replication-status>
  <div class={top}>
    <div class={titleGroup}>
      <h2 class={sectionTitle} id="device-replication-title">This Device replication</h2>
      <p class={meta}>Outbound publication of selected Usage and Memory facts.</p>
    </div>
    <button
      class={ghostButton}
      disabled={statusQuery.isFetching}
      onclick={() => statusQuery.refetch().catch(() => undefined)}
      type="button"
    >
      {statusQuery.isFetching ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
  <div aria-atomic="true" aria-live="polite">
    {#if status && presentation}
      <div class={top}>
        <div class={titleGroup}>
          <span class={cx(statusPill, sourceToneClass(presentation.tone))} data-replication-mode={status.mode}
            >{presentation.label}</span
          >
          <p class={meta}>{presentation.explanation}</p>
        </div>
        {#if diagnostic}
          <p class={meta} data-replication-diagnostic>{diagnostic}</p>
        {/if}
      </div>
      {#if status.mode === 'connected'}
        <div class={streamGrid}>
          {#each streams as stream (stream.label)}
            <article class={streamCard} data-replication-stream={stream.label.toLowerCase()}>
              <div class={streamTop}>
                <h3 class={streamTitle}>{stream.label}</h3>
                {#if stream.status}
                  {@const streamPresentation = presentReplicationStream(stream.status)}
                  <span
                    class={cx(statusPill, sourceToneClass(streamPresentation.tone))}
                    title={streamPresentation.explanation}
                    >{streamPresentation.label}</span
                  >
                {:else}
                  <span class={cx(statusPill, sourceToneClass('info'))}>Preparing</span>
                {/if}
              </div>
              {#if stream.status}
                <div class={facts}>
                  <div class={fact}>
                    <span class={factLabel}>Published</span>
                    <span class={factValue}>{fmtNum(stream.status.acknowledged)}</span>
                  </div>
                  <div class={fact}>
                    <span class={factLabel}>Queued</span>
                    <span class={factValue}>{fmtNum(stream.status.pending + stream.status.inFlight)}</span>
                  </div>
                  <div class={fact}>
                    <span class={factLabel}>Blocked</span>
                    <span class={factValue}>{fmtNum(stream.status.blocked)}</span>
                  </div>
                  <div class={fact}>
                    <span class={factLabel}>Generation</span>
                    <span class={factValue}>{fmtNum(stream.status.acknowledgedThroughGeneration)}</span>
                  </div>
                </div>
                <p class={meta} data-replication-freshness>
                  Last server confirmation {fmtDate(stream.status.lastAcknowledgedAt)} · oldest queued
                  {fmtDate(stream.status.oldestUnacknowledgedAt)}
                  · next retry {fmtDate(stream.status.nextRetryAt)}
                </p>
                {#if stream.status.lastErrorCode}
                  <p class={meta}>Last issue: {stream.status.lastErrorCode}</p>
                {/if}
              {:else}
                <p class={meta}>The stream is being prepared; local writes continue independently.</p>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {:else if statusQuery.isPending}
      <p class={meta}>Reading the content-free replication status…</p>
    {:else}
      <p class={meta}>Replication status is temporarily unavailable; local collection and Memory remain available.</p>
    {/if}
  </div>
</section>
