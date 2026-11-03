<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import { reportBootstrapQueryOptions } from '../../query/options/report';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
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
  const content = css({ display: 'grid', gap: '24px', minW: 0 });
  const controls = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    alignItems: 'end',
    '& label': { display: 'grid', gap: '6px', fontSize: '12px' },
    '& input, & select': {
      p: '8px',
      maxW: 'full',
      border: '1px solid token(colors.line)',
      borderRadius: 'sm',
      bg: 'surface',
      color: 'ink',
    },
  });
  const muted = css({ color: 'muted', fontSize: '13px', overflowWrap: 'anywhere' });
</script>
<svelte:head><title>Observatory · AI Usage</title></svelte:head>
<main class={pageClass}>
  <div class={shell}>
    <WorkspaceHeader description="Follow observed tokens across projects, models and sessions." heading="Observatory" />
    <div class={content}>
      <form action="/observatory" class={controls} method="GET">
        {#each [...page.url.searchParams].filter(([key]) => key !== 'range' && key !== 'q') as [key, value]}
          <input name={key} type="hidden" {value}>
        {/each}
        <label
          >Period<select name="range" value={page.url.searchParams.get('range') ?? '30d'}>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
            <option value="all">All history</option>
          </select></label
        >
        <label>Search sessions<input name="q" type="search" value={page.url.searchParams.get('q') ?? ''}></label>
        <button class={ghostButton} type="submit">Apply filters</button>
        <a class={ghostButton} href={`/campaigns${page.url.search}`}>Explore campaigns</a>
      </form>
      {#if data.mode !== 'live'}
        <p class={muted}>Synthetic demonstration · no local history is read.</p>
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
        <p class={muted}>
          Report captured {generatedAt}. The diagram uses all matching recorded sessions. Automated reviews follow the
          selected origin filters. Tokens do not measure cost or current activity.
        </p>
        {#if bootstrap.data?.ok && bootstrap.data.bootstrap.support.omittedRows > 0}
          <p class={muted} role="status">
            The report omitted {bootstrap.data.bootstrap.support.omittedRows} rows before filtering. Coverage is
            incomplete.
          </p>
        {/if}
        {#each query.data?.context.warnings ?? [] as warning}
          <p class={muted} role="status">{warning.message}</p>
        {/each}
        <TokenFlow {flow} />
      {:else}
        <p role="status">Loading the report revision…</p>
      {/if}
    </div>
  </div>
</main>
