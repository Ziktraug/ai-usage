<script lang="ts">
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import { originProvenanceFor } from '@ai-usage/report-core/provenance';
  import {
    type SessionPageItem,
    type SessionPresentationRow,
    sessionOriginLabel,
  } from '@ai-usage/report-core/session-query';
  import { createInfiniteQuery } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';
  import { browser } from '$app/env';
  import { loadNextCampaignPage } from '../../query/options/campaigns';
  import { sessionCampaignInfiniteOptions } from '../../query/options/session-window';
  import { workRequest } from '../../query/options/work';
  import type { SessionClientAdapter } from '../../rpc/session-client';
  import { sessionRoutePathname } from '../sessions/detail/session-route';
  import { workButton, workHeading, workLink, workMuted, workPanel, workRow, workStack } from './work-styles';

  let {
    item,
    revision,
    client,
    onSelect,
  }: {
    item: SessionPageItem;
    revision: string;
    client: SessionClientAdapter;
    onSelect: (row: SessionPresentationRow) => void;
  } = $props();
  let expanded = $state(false);
  let hydrated = $state(false);
  let relatedDetails = $state<HTMLDetailsElement>();
  onMount(() => {
    // Native disclosure can be opened before hydration installs the toggle handler.
    expanded = relatedDetails?.open ?? false;
    hydrated = true;
  });
  const children = createInfiniteQuery(() => ({
    ...sessionCampaignInfiniteOptions(client, workRequest(revision), item.campaignKey, 'campaign-sessions'),
    enabled: browser && expanded,
  }));
  const row = $derived(item.row);
  const members = $derived(children.data?.pages.flatMap((page) => page.items) ?? []);
  const memberCount = $derived(Math.max(0, (row.campaignTotalCount ?? 1) - 1));
  const detailHref = (entry: SessionPresentationRow) =>
    `${sessionRoutePathname({ kind: 'session', rowId: entry.rowId })}?tab=sessions&range=all`;
</script>

<article class={workPanel} data-work-hydrated={hydrated} data-work-session={row.rowId}>
  <div class={workStack}>
    <div class={workRow}>
      <HarnessBadge name={row.harness} />
      <h2 class={workHeading}>{row.sessionLabel || row.name || 'Untitled session'}</h2>
    </div>
    <p class={workMuted}>
      {row.projectLabel}
      · {row.source?.machineLabel ?? row.source?.machineId ?? 'Machine unrecorded'}
      · {row.origin ? sessionOriginLabel(row.origin) : 'Origin undeclared'}
      · Last recorded activity across related sessions: {row.activeDate ?? row.endDate ?? row.date ?? 'unavailable'}
    </p>
    <p class={workMuted}>
      Known waits unavailable ·
      {row.partial || row.usageUnavailable
        ? 'Partial session coverage'
        : 'Recorded usage only; work outcomes unobserved'}
    </p>
    {#if row.originProvenance}
      <p class={workMuted}>{originProvenanceFor(row.originProvenance).description}</p>
    {/if}
    {#if !row.source?.sourceSessionId}
      <p class={workMuted}>Native session identity is unavailable; no cross-session relationship is inferred.</p>
    {/if}
    {#if row.source?.parentSourceSessionId}
      <p class={workMuted}>
        Declared parent: {row.source.parentSourceSessionId}. The parent is not this root; inspect related sessions and
        collection warnings for its coverage.
      </p>
    {:else if row.origin === 'subagent' || row.subagent}
      <p class={workMuted}>
        Parent relationship unavailable · No parent identifier is present in this observation. Delegated origin does not
        establish which session launched it.
      </p>
    {/if}
    <div class={workRow}>
      <a class={workLink} href={detailHref(row)}>Open session detail</a>
      <button class={workButton} onclick={() => onSelect(row)} type="button">Simulate review assignment</button>
    </div>
    {#if memberCount > 0}
      <details
        ontoggle={(event) => {
          expanded = event.currentTarget.open;
        }}
        bind:this={relatedDetails}
      >
        <summary class={workLink}>{memberCount} related sessions and technical reviews</summary>
        {#if expanded}
          {#if children.error}
            <p class={workMuted} role="alert">Related sessions could not be read at this revision.</p>
            <button class={workButton} onclick={() => children.refetch()} type="button">Retry related sessions</button>
          {:else if children.isPending}
            <p class={workMuted} role="status">Reading related sessions…</p>
          {:else}
            <ul>
              {#each members as child (child.rowId)}
                <li class={workMuted}>
                  <a class={workLink} href={detailHref(child)}
                    >{child.sessionLabel || child.name || 'Untitled child'}</a
                  >
                  · {child.origin ? sessionOriginLabel(child.origin) : 'Origin undeclared'}
                  ·
                  {child.source?.parentSourceSessionId
                    ? `Declared parent: ${child.source.parentSourceSessionId}`
                    : 'Parent not declared'}
                </li>
              {/each}
            </ul>
            {#if children.hasNextPage}
              <button
                class={workButton}
                disabled={children.isFetching}
                onclick={() => loadNextCampaignPage(children)}
                type="button"
              >
                Load more related sessions
              </button>
            {/if}
          {/if}
        {/if}
      </details>
    {/if}
  </div>
</article>
