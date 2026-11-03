<script lang="ts">
  import { ghostButton } from '@ai-usage/design-system/report';
  import { page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import { parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
  import { reportBootstrapQueryOptions } from '../../query/options/report';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import { sessionRouteUrl } from '../sessions/detail/session-route';
  import { dashboardSearchCodec } from '../shell/navigation';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import Constellation from './constellation.svelte';
  import type { ObservatoryPageData } from './observatory-load';
  import {
    observatoryFixtureDate,
    observatoryFixtureRevision,
    observatoryQueryOptions,
    observatoryRequest,
  } from './observatory-query';
  import TokenFlow from './token-flow.svelte';

  let { data }: { data: ObservatoryPageData } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const client = untrack(() =>
    browser && rpc
      ? createReportClient(rpc)
      : ssrUnavailableClient<ReturnType<typeof createReportClient>>('observatory'),
  );
  const bootstrap = createQuery(() => ({
    ...reportBootstrapQueryOptions(client, { browser }),
    enabled: browser && data.mode === 'live',
  }));
  const manifest = $derived(bootstrap.data?.ok ? bootstrap.data.manifest : null);
  const revision = $derived(data.mode === 'live' ? manifest?.revision : observatoryFixtureRevision);
  const generatedAt = $derived(manifest?.generatedAt ?? observatoryFixtureDate);
  const request = $derived(observatoryRequest(new URL(page.url.href), revision ?? 'pending-observatory', generatedAt));
  const query = createQuery(() => ({
    ...observatoryQueryOptions(client, request, data.mode),
    enabled: browser && Boolean(revision),
  }));
  const flow = $derived(query.data?.tokenFlow);
  const search = $derived(parseDashboardSearchUrl(new URL(page.url.href), dashboardSearchCodec));
  const projectless = $derived(Object.fromEntries(Object.entries(search.filters).filter(([key]) => key !== 'project')));
  const sessionHref = (rowId: string) => sessionRouteUrl(new URL(page.url.href), { kind: 'session', rowId }).href;
</script>
<svelte:head><title>Observatory · AI Usage</title></svelte:head>
<main class={pageClass}>
  <div class={shell}>
    <WorkspaceHeader description="Follow observed tokens across projects, models and sessions." heading="Observatory" />
    <div class="content">
      <form action="/observatory" class="controls" method="GET">
        {#each [...page.url.searchParams].filter(
          ([key]) => !['range', 'q', 'filters', 'harness'].includes(key),
        ) as [key, value]}
          <input name={key} type="hidden" {value}>
        {/each}
        <label
          >Period<select name="range" value={page.url.searchParams.get('range') ?? '30d'}>
            <option value="today">Today</option>
            {#if page.url.searchParams.get('range')?.includes('..')}
              <option value={page.url.searchParams.get('range')!}>
                Custom period: {page.url.searchParams.get('range')}
              </option>
            {/if}
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
            <option value="all">All history</option>
          </select></label
        >
        <label>Search sessions<input name="q" type="search" value={page.url.searchParams.get('q') ?? ''}></label>
        <label
          >Project<select name="filters" value={JSON.stringify(search.filters)}>
            <option value={JSON.stringify(projectless)}>All projects</option>
            {#each query.data?.groups.projects ?? [] as group (group.key)}
              <option value={JSON.stringify({ ...search.filters, project: group.key })}>{group.label}</option>
            {/each}
            {#if search.filters.project &&
              !query.data?.groups.projects.some((group) => group.key === search.filters.project)}
              <option value={JSON.stringify(search.filters)}>{search.filters.project}</option>
            {/if}
          </select></label
        >
        <label
          >Harness<select name="harness" value={JSON.stringify(search.harness)}>
            <option value="[]">All harnesses</option>
            {#each query.data?.groups.harnesses ?? [] as group (group.key)}
              <option value={JSON.stringify([group.key])}>{group.key}</option>
            {/each}
            {#if search.harness.length > 1 ||
              (search.harness.length === 1 &&
                !query.data?.groups.harnesses.some((group) => group.key === search.harness[0]))}
              <option value={JSON.stringify(search.harness)}>Selected harnesses</option>
            {/if}
          </select></label
        >
        <button class={ghostButton} type="submit">Apply filters</button>
        <a class={ghostButton} href={`/campaigns${page.url.search}`}>Explore campaigns</a>
      </form>
      {#if data.mode !== 'live'}
        <p class="muted">Synthetic demonstration · no local history is read.</p>
      {/if}
      {#if query.error || bootstrap.error || bootstrap.data?.ok === false}
        <p role="alert">{query.error?.message ?? bootstrap.error?.message ?? 'The report revision is unavailable.'}</p>
        <button
          class={ghostButton}
          onclick={async () => {
            await bootstrap.refetch();
            await query.refetch();
          }}
          type="button"
        >
          Retry observatory
        </button>
      {:else if flow}
        <p class="muted">
          Report captured {generatedAt}. The diagram uses all matching recorded sessions. Automated reviews follow the
          selected origin filters. Tokens do not measure cost or current activity.
        </p>
        {#if bootstrap.data?.ok && bootstrap.data.bootstrap.support.omittedRows > 0}
          <p class="muted" role="status">
            The report omitted {bootstrap.data.bootstrap.support.omittedRows} rows before filtering. Coverage is
            incomplete.
          </p>
        {/if}
        {#each query.data?.context.warnings ?? [] as warning}
          <p class="muted" role="status">{warning.message}</p>
        {/each}
        <TokenFlow {flow} />
        {#if query.data?.constellation}
          <Constellation map={query.data.constellation} {sessionHref} />
        {/if}
      {:else}
        <p role="status">Loading the report revision…</p>
      {/if}
    </div>
  </div>
</main>

<style>
  .content {
    display: grid;
    gap: 24px;
    min-width: 0;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: end;
  }
  .controls label {
    display: grid;
    gap: 6px;
    font-size: 12px;
  }
  .controls input,
  .controls select {
    max-width: 100%;
    padding: 8px;
    color: var(--colors-ink);
    background: var(--colors-surface);
    border: 1px solid var(--colors-line);
    border-radius: var(--radii-sm);
  }
  .muted {
    font-size: 13px;
    color: var(--colors-muted);
    overflow-wrap: anywhere;
  }
</style>
