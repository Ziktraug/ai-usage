<script lang="ts">
  import {
    WORK_THREAD_TABS,
    WORK_THREAD_VIEW_BOUNDS,
    type WorkThreadTab,
  } from '@ai-usage/report-core/work-thread-view';
  import { createQueries } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import { browser } from '$app/env';
  import { workThreadListQueryOptions } from '../../../query/options/work-threads';
  import type { WorkThreadsClient } from '../../../rpc/work-threads-client';
  import { aggregateDiskSources, type DiskPageChain, diskPageChain } from './work-disk-model';
  import WorkDiskTable from './work-disk-table.svelte';

  let {
    threads,
    href,
    switcher,
    timeZone,
  }: {
    threads: Pick<WorkThreadsClient, 'list'>;
    href: (threadId: string) => string;
    /** The page's lens switcher: the way to the other views. */
    switcher: Snippet;
    timeZone: string;
  } = $props();

  // The lens must see every task of both tabs, so it reads each tab page after page: a page's
  // answer names the next one. The chain grows as pages answer and is walked again from the first
  // page whenever one refreshes.
  let chains = $state<Record<WorkThreadTab, DiskPageChain>>({
    open: { complete: false, cursors: [null] },
    done: { complete: false, cursors: [null] },
  });
  const pages = $derived(WORK_THREAD_TABS.flatMap((tab) => chains[tab].cursors.map((cursor) => ({ cursor, tab }))));
  const queries = createQueries(() => ({
    queries: pages.map(({ cursor, tab }) =>
      workThreadListQueryOptions(
        threads,
        { cursor, limit: WORK_THREAD_VIEW_BOUNDS.maxPageSize, project: null, search: null, tab },
        { browser, enabled: true },
      ),
    ),
  }));
  $effect(() => {
    // Both chains are computed from one snapshot of the pages and their answers, then written.
    // Writing a tab's chain re-derives `pages` at once while `queries` only follows on the next
    // flush, so reading them again in this run would pair the other tab's pages with other answers.
    if (queries.length !== pages.length) {
      return;
    }
    const answered = pages.map((page, index) => ({ ...page, answer: queries[index]?.data }));
    const walked = WORK_THREAD_TABS.map((tab) => ({
      chain: diskPageChain((cursor) => {
        const answer = answered.find((page) => page.tab === tab && page.cursor === cursor)?.answer;
        return answer?.ok ? answer.data.nextCursor : undefined;
      }),
      known: chains[tab],
      tab,
    }));
    for (const { chain, known, tab } of walked) {
      if (chain.complete !== known.complete || chain.cursors.join('\n') !== known.cursors.join('\n')) {
        chains[tab] = chain;
      }
    }
  });

  const datasets = $derived(queries.flatMap((result) => (result.data?.ok ? [result.data.data] : [])));
  const newest = $derived(
    datasets.reduce<(typeof datasets)[number] | null>(
      (latest, dataset) =>
        latest === null || Date.parse(dataset.generatedAt) > Date.parse(latest.generatedAt) ? dataset : latest,
      null,
    ),
  );
  const rows = $derived([
    ...new Map(datasets.flatMap((dataset) => dataset.rows).map((row) => [row.thread.threadId, row])).values(),
  ]);
  // Each page reports its own run of the sources: a truncation on one page must stay visible.
  const sources = $derived(aggregateDiskSources(datasets.map((dataset) => dataset.sources)));
  const complete = $derived(WORK_THREAD_TABS.every((tab) => chains[tab].complete));
  const fetching = $derived(queries.some((result) => result.isFetching));
  const failure = $derived(
    queries
      .map((result) => (result.data && !result.data.ok ? result.data.error.message : result.error?.message))
      .find(Boolean) ?? null,
  );
  const retry = (): void => {
    for (const result of queries) {
      result.refetch();
    }
  };
</script>

<header class="wt-page-head">
  <div>
    <p class="wt-eyebrow">My work · Disk</p>
    <h1>Checkouts on this machine</h1>
  </div>
  <div class="wt-page-meta">
    {@render switcher()}
  </div>
</header>
{#if failure}
  <div class="wt-alert" role="alert">
    <strong>Checkouts unavailable</strong>
    <p>{failure} This does not establish that there are no checkouts.</p>
    <button class="wt-button" onclick={retry} type="button">Retry</button>
  </div>
{/if}
{#if newest}
  {#if !(complete || failure) && fetching}
    <p class="wt-meta" role="status">Reading the remaining tasks…</p>
  {/if}
  <WorkDiskTable
    coverage={{ complete, loaded: rows.length, total: newest.counts.open + newest.counts.done }}
    {href}
    now={newest.generatedAt}
    {rows}
    {sources}
    {timeZone}
  />
{:else if !failure}
  <p class="wt-empty" role="status">Reading checkouts…</p>
{/if}
