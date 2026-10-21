<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { SessionPageResult, SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import {
    createInfiniteQuery,
    createQuery,
    type InfiniteData,
    keepPreviousData,
    type QueryKey,
  } from '@tanstack/svelte-query';
  import { tick, untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { loadNextCampaignPage, retainedCampaignOptions } from '../../query/options/campaigns';
  import { quotaRailQueryOptions } from '../../query/options/quota';
  import { reportBootstrapQueryOptions } from '../../query/options/report';
  import { SessionRevisionExpiredError } from '../../query/options/session-window';
  import { workSessionsOptions } from '../../query/options/work';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { createSessionClientAdapter } from '../../rpc/session-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import type { WorkPageData } from './work-load';
  import WorkRouting from './work-routing.svelte';
  import WorkSession from './work-session.svelte';
  import WorkSources from './work-sources.svelte';
  import { workButton, workHeading, workMuted, workPanel, workStack } from './work-styles';
  import { createSyntheticWorkClient, WORK_DEMO_REVISION, WORK_DEMO_TIME } from './work-synthetic';

  let { data }: { data: WorkPageData } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const clients = untrack(() => {
    const report =
      browser && rpc
        ? createReportClient(rpc)
        : ssrUnavailableClient<ReturnType<typeof createReportClient>>('Work report');
    if (data.mode !== 'live') {
      return { report, session: createSyntheticWorkClient() };
    }
    const session =
      browser && rpc
        ? createSessionClientAdapter(rpc.session)
        : ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('Work sessions');
    return { report, session };
  });
  const bootstrapQuery = createQuery(() =>
    reportBootstrapQueryOptions(clients.report, { browser: browser && data.mode === 'live' }),
  );
  const bootstrap = $derived(bootstrapQuery.data?.ok ? bootstrapQuery.data : null);
  const revision = $derived(
    data.mode === 'live' ? (bootstrap?.manifest.revision ?? 'work-unavailable') : WORK_DEMO_REVISION,
  );
  const generatedAt = $derived(data.mode === 'live' ? (bootstrap?.manifest.generatedAt ?? null) : WORK_DEMO_TIME);
  let lastReadableKey = $state<QueryKey>();
  let checkedExpiredRevision = '';
  const sessions = createInfiniteQuery(() => ({
    ...workSessionsOptions(clients.session, revision),
    placeholderData: keepPreviousData,
    enabled: browser && (data.mode !== 'live' || bootstrap !== null),
  }));
  const retained = createQuery(() =>
    retainedCampaignOptions<InfiniteData<SessionPageResult, string | null>>(lastReadableKey),
  );
  const displayed = $derived(sessions.data ?? retained.data);
  const displayedRevision = $derived(displayed?.pages[0]?.revision ?? revision);
  $effect(() => {
    if (sessions.data && !sessions.isPlaceholderData && !sessions.error) {
      lastReadableKey = workSessionsOptions(clients.session, revision).queryKey;
    }
    if (
      data.mode === 'live' &&
      sessions.error instanceof SessionRevisionExpiredError &&
      checkedExpiredRevision !== revision
    ) {
      checkedExpiredRevision = revision;
      bootstrapQuery.refetch();
    }
  });
  const quotas = createQuery(() => quotaRailQueryOptions(clients.report, { browser, enabled: data.mode === 'live' }));
  const items = $derived(displayed?.pages.flatMap((result) => result.items) ?? []);
  const ordinary = $derived(items.filter((item) => item.row.origin !== 'classifier'));
  const reviews = $derived(items.filter((item) => item.row.origin === 'classifier'));
  let selectedRowId = $state<string | null>(null);
  const selected = $derived(items.find((item) => item.row.rowId === selectedRowId)?.row ?? null);
  let routingHeading = $state<HTMLElement>();
  let reviewsOpen = $state(false);
  const select = async (row: SessionPresentationRow): Promise<void> => {
    selectedRowId = row.rowId;
    await tick();
    routingHeading?.focus();
  };
  const unavailable = $derived(
    bootstrapQuery.error ||
      (bootstrapQuery.data && !bootstrapQuery.data.ok) ||
      sessions.error ||
      (data.initialFailure && !sessions.data),
  );
</script>

<svelte:head><title>Work · ai-usage</title></svelte:head>
<div class={shell}>
  <main class={page} data-route-shell="work">
    <WorkspaceHeader
      description="Find the session to resume, inspect its evidence, and simulate a read-only review assignment."
      eyebrow="Observed work"
      heading="Work"
    />
    <div class={workStack}>
      {#if data.mode !== 'live'}
        <p class={workMuted}>
          Synthetic demonstration · no local history is read. Routing eligibility is fixture data.
        </p>
      {/if}
      <WorkSources {generatedAt} mode={data.mode} support={bootstrap?.bootstrap ?? null} />
      <div
        class={css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '12px', alignItems: 'center' })}
      >
        <h2 class={workHeading}>Observed sessions</h2>
        <p class={workMuted}>
          {items.length}
          of {displayed?.pages[0]?.itemCount ?? 'unknown'} session roots loaded · most recent first
        </p>
      </div>
      {#if displayedRevision !== revision}
        <p class={workMuted} role="status">
          Showing the previous readable revision while newer observations are
          {sessions.error ? 'unavailable' : 'loading'}. Related sessions use that same retained revision.
        </p>
      {/if}
      {#if unavailable}
        <section class={workPanel} role="alert">
          <p class={workHeading}>Work observations are unavailable</p>
          {#if data.initialFailure && !sessions.data}
            <p class={workMuted}>{data.initialFailure.message}</p>
          {/if}
          <p class={workMuted}>
            The stored revision could not be read. This does not establish that there is nothing to do.
          </p>
          <button class={workButton} onclick={() => { bootstrapQuery.refetch(); sessions.refetch(); }} type="button">
            Retry stored observations
          </button>
        </section>
      {:else if items.length === 0}
        <p class={workMuted} role="status">
          {sessions.isPending ? 'Reading stored session observations…' : 'No session roots were observed in this revision. Source coverage and outstanding work remain unknown.'}
        </p>
      {/if}
      {#each ordinary as item (item.row.rowId)}
        <WorkSession client={clients.session} {item} onSelect={select} revision={displayedRevision} />
      {/each}
      {#if reviews.length > 0}
        <details class={workPanel} ontoggle={(event) => { reviewsOpen = event.currentTarget.open; }}>
          <summary class={workHeading}>Standalone automated reviews ({reviews.length})</summary>
          {#if reviewsOpen}
            {#each reviews as item (item.row.rowId)}
              <WorkSession client={clients.session} {item} onSelect={select} revision={displayedRevision} />
            {/each}
          {/if}
        </details>
      {/if}
      {#if sessions.hasNextPage && displayedRevision === revision}
        <button
          class={workButton}
          disabled={sessions.isFetching}
          onclick={() => loadNextCampaignPage(sessions)}
          type="button"
        >
          Load more observed sessions
        </button>
      {/if}
      {#if selected}
        <section aria-labelledby="work-routing-heading" class={workPanel}>
          <h2 class={workHeading} id="work-routing-heading" tabindex="-1" bind:this={routingHeading}>
            Review assignment simulation
          </h2>
          <WorkRouting
            mode={data.mode}
            providers={quotas.data?.latest ?? []}
            quotaUnavailable={Boolean(quotas.error) || !quotas.data}
            target={selected}
          />
        </section>
      {/if}
    </div>
  </main>
</div>
