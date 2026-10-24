<script lang="ts">
  import { shell } from '@ai-usage/design-system/svelte';
  import { isWorkThreadId, sessionLinkKey, type WorkThreadCommand } from '@ai-usage/report-core/work-thread';
  import { createInfiniteQuery, createQueries, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, tick, untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import { reportBootstrapQueryOptions } from '../../query/options/report';
  import { workSessionsOptions } from '../../query/options/work';
  import {
    invalidateWorkThreadQueries,
    loadNextLinkableSessionPage,
    workThreadDetailQueryOptions,
    workThreadListQueryOptions,
  } from '../../query/options/work-threads';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { createSessionClientAdapter } from '../../rpc/session-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import { createWorkThreadsClient, type WorkThreadsClient } from '../../rpc/work-threads-client';
  import { useShellNavigationOwner } from '../shell/navigation-owner-context';
  import { createSyntheticWorkClient, WORK_DEMO_REVISION } from './work-synthetic';
  import WorkThreadDetail from './work-thread-detail.svelte';
  import WorkThreadList from './work-thread-list.svelte';
  import type { ThreadPageData } from './work-thread-load';
  import {
    harnessName,
    THREAD_PAGE_WINDOW,
    threadListQuery,
    threadMoreUrl,
    threadPageCursors,
    threadUrl,
  } from './work-thread-model';
  import WorkThreadSources from './work-thread-sources.svelte';
  import { threadSurface } from './work-thread-styles';
  import './work-threads.css';

  let { data }: { data: ThreadPageData } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const queryClient = useQueryClient();
  const navigation = useShellNavigationOwner();
  const clients = untrack(() => {
    const liveSessions =
      browser && rpc
        ? createSessionClientAdapter(rpc.session)
        : ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('Task sessions');
    return {
      threads:
        browser && rpc ? createWorkThreadsClient(rpc.workThreads) : ssrUnavailableClient<WorkThreadsClient>('Tasks'),
      report:
        browser && rpc
          ? createReportClient(rpc)
          : ssrUnavailableClient<ReturnType<typeof createReportClient>>('Task sessions report'),
      sessions: data.mode === 'live' ? liveSessions : createSyntheticWorkClient(),
    };
  });
  let timeZone = $state('UTC');
  let hydrated = $state(false);
  let pickerOpen = $state(false);
  onMount(() => {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    hydrated = true;
  });
  const taskId = $derived(page.url.searchParams.get('task'));
  const query = $derived(threadListQuery(page.url.searchParams));
  const cursors = $derived(threadPageCursors(page.url.searchParams));
  const listQueries = createQueries(() => ({
    queries: cursors.map((cursor) =>
      workThreadListQueryOptions(clients.threads, { ...query, cursor }, { browser, enabled: true }),
    ),
  }));
  const answered = $derived(listQueries.flatMap((result) => (result.data?.ok ? [result.data.data] : [])));
  // A tab, search or project change starts new queries with no data yet; the previous pages stay on
  // screen until they answer, so the toolbar (and the focused tab) is never unmounted for a spinner.
  let lastAnswered = $state<typeof answered>([]);
  $effect(() => {
    if (answered.length > 0) {
      lastAnswered = answered;
    }
  });
  const datasets = $derived(answered.length > 0 ? answered : lastAnswered);
  const dataset = $derived(datasets.at(-1) ?? null);
  const rows = $derived([
    ...new Map(datasets.flatMap((value) => value.rows).map((row) => [row.thread.threadId, row])).values(),
  ]);
  const listError = $derived(
    listQueries
      .map((result) => (result.data && !result.data.ok ? result.data.error.message : result.error?.message))
      .find(Boolean) ?? null,
  );
  const detailQuery = createQuery(() =>
    workThreadDetailQueryOptions(clients.threads, taskId ?? '', { browser, enabled: isWorkThreadId(taskId) }),
  );
  const detail = $derived(taskId && detailQuery.data?.ok ? detailQuery.data.data : null);
  const selectedIndex = $derived(rows.findIndex((row) => row.thread.threadId === taskId));
  const previous = $derived(selectedIndex > 0 ? (rows[selectedIndex - 1]?.thread.threadId ?? null) : null);
  const next = $derived(selectedIndex >= 0 ? (rows[selectedIndex + 1]?.thread.threadId ?? null) : null);
  const detailError = $derived.by(() => {
    if (taskId && !isWorkThreadId(taskId)) {
      return 'Invalid task identifier.';
    }
    return detailQuery.data && !detailQuery.data.ok
      ? detailQuery.data.error.message
      : (detailQuery.error?.message ?? null);
  });
  const navigate = (url: string | URL, replaceState = false): Promise<void> =>
    navigation.goto(url, { keepFocus: true, noScroll: true, replaceState });
  const href = (id: string, day?: string): string => threadUrl(page.url, id, day);
  const updateFilter = (patch: Partial<ReturnType<typeof threadListQuery>>): Promise<void> => {
    const url = new URL(page.url);
    url.searchParams.delete('cursor');
    url.searchParams.delete('start');
    url.searchParams.delete('scroll');
    if ('tab' in patch) {
      url.searchParams.set('tab', patch.tab ?? 'open');
    }
    if ('search' in patch) {
      if (patch.search) {
        url.searchParams.set('q', patch.search);
      } else {
        url.searchParams.delete('q');
      }
    }
    if ('project' in patch) {
      if (patch.project) {
        url.searchParams.set('project', patch.project);
      } else {
        url.searchParams.delete('project');
      }
    }
    return navigate(url, true);
  };
  const open = async (event: MouseEvent, id: string, day?: string): Promise<void> => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const saved = new URL(page.url);
    saved.searchParams.set('scroll', String(Math.round(window.scrollY)));
    saved.searchParams.set('focus', id);
    await navigate(saved, true);
    await navigate(threadUrl(saved, id, day));
    window.scrollTo(0, 0);
    await tick();
    document.querySelector<HTMLElement>('[data-work-threads]')?.focus();
  };
  const back = async (event: MouseEvent): Promise<void> => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    await navigate(threadUrl(page.url, null));
    await tick();
    restoreList();
  };
  const restoreList = (): void => {
    const scroll = Number(page.url.searchParams.get('scroll') ?? 0);
    const focus = page.url.searchParams.get('focus');
    if (focus && isWorkThreadId(focus)) {
      document
        .querySelector<HTMLElement>(`[data-work-thread="${focus}"] .wt-task-title`)
        ?.focus({ preventScroll: true });
    }
    window.scrollTo(0, Number.isFinite(scroll) ? Math.max(0, scroll) : 0);
  };
  let previousTask = untrack(() => taskId);
  $effect(() => {
    const current = taskId;
    if (!current && previousTask && hydrated) {
      tick().then(restoreList);
    }
    previousTask = current;
  });
  const command = async (input: WorkThreadCommand) => {
    const result = await clients.threads.command(input);
    const requestedId = 'threadId' in input ? input.threadId : null;
    const id = result.ok ? result.threadId : requestedId;
    if (id) {
      await invalidateWorkThreadQueries(queryClient, id);
    }
    return result;
  };
  const bootstrapQuery = createQuery(() =>
    reportBootstrapQueryOptions(clients.report, { browser: browser && pickerOpen && data.mode === 'live' }),
  );
  const bootstrap = $derived(bootstrapQuery.data?.ok ? bootstrapQuery.data : null);
  const revision = $derived(
    data.mode === 'live' ? (bootstrap?.manifest.revision ?? 'unavailable') : WORK_DEMO_REVISION,
  );
  const sessions = createInfiniteQuery(() => ({
    ...workSessionsOptions(clients.sessions, revision),
    enabled: browser && pickerOpen && (data.mode !== 'live' || bootstrap !== null),
  }));
  const choices = $derived(
    (sessions.data?.pages.flatMap((result) => result.items) ?? []).flatMap(({ row }) => {
      if (
        !detail ||
        row.projectLabel !== detail.row.thread.projectLabel ||
        !row.source?.machineId ||
        !row.source.sourceSessionId
      ) {
        return [];
      }
      return [
        {
          key: sessionLinkKey({
            harness: row.source.harnessKey,
            machineId: row.source.machineId,
            sessionId: row.source.sourceSessionId,
          }),
          title: row.sessionLabel || row.name || 'Untitled session',
          caption: `${harnessName(row.harness)} · ${row.projectLabel}`,
        },
      ];
    }),
  );
</script>

<svelte:head><title>{detail?.row.thread.title ?? 'My work'} · ai-usage</title></svelte:head>
<div class={shell}>
  <main
    class={`${threadSurface} wt-surface`}
    data-route-shell="work"
    data-work-hydrated={hydrated}
    data-work-threads
    tabindex="-1"
    class:wt-focus={Boolean(taskId)}
  >
    {#if taskId}
      {#if data.mode !== 'live'}
        <p class="wt-meta">Synthetic demo</p>
      {/if}
      {#if detail}
        <WorkThreadSources now={detail.generatedAt} sources={detail.sources} {timeZone} />
        {#key detail.row.thread.threadId}
          <WorkThreadDetail
            backHref={threadUrl(page.url, null)}
            data={detail}
            moreSessions={sessions.hasNextPage}
            nextHref={next ? href(next) : null}
            onBack={back}
            onCommand={command}
            onMoreSessions={() => loadNextLinkableSessionPage(sessions)}
            onPickerOpen={() => pickerOpen = true}
            previousHref={previous ? href(previous) : null}
            selectedDay={page.url.searchParams.get('day')}
            sessionChoices={choices}
            sessionsError={sessions.error?.message ?? bootstrapQuery.error?.message ?? (bootstrapQuery.data && !bootstrapQuery.data.ok ? 'Recent sessions are unavailable.' : null)}
            sessionsLoading={sessions.isFetching || bootstrapQuery.isFetching}
            {timeZone}
          />
        {/key}
      {:else if detailError}
        <div class="wt-empty" role="alert">
          <h1>Task unavailable</h1>
          <p>{detailError}</p>
          <a class="wt-link" href={threadUrl(page.url, null)}>← My work</a
          ><button class="wt-button" onclick={() => detailQuery.refetch()} type="button">Retry task</button>
        </div>
      {:else}
        <p class="wt-empty" role="status">Reading this task…</p>
      {/if}
    {:else}
      <header class="wt-page-head">
        <div>
          <p class="wt-eyebrow">My work</p>
          <h1>One thread per task.</h1>
          <p class="wt-subtitle">Sessions pass. The follow-up stays, until you end it.</p>
        </div>
        <div class="wt-page-meta">
          {#if data.mode !== 'live'}
            <span>Synthetic demo</span>
          {/if}
          <a class="wt-link" href="/work/sessions">Session intake ↗</a>
        </div>
      </header>
      {#if dataset}
        <WorkThreadSources now={dataset.generatedAt} sources={dataset.sources} {timeZone} />
      {/if}
      {#if listError}
        <div class="wt-alert" role="alert">
          <strong>Tasks unavailable</strong>
          <p>{listError} This does not establish that there are no tasks.</p>
          <button
            class="wt-button"
            onclick={() => { for (const result of listQueries) { result.refetch(); } }}
            type="button"
          >
            Retry tasks
          </button>
        </div>
      {/if}
      {#if dataset}
        <WorkThreadList
          continuation={cursors.length >= THREAD_PAGE_WINDOW}
          {dataset}
          {href}
          loadingMore={listQueries.some((result) => result.isFetching)}
          onFilter={updateFilter}
          onMore={() => { if (dataset.nextCursor) { const more = threadMoreUrl(page.url, dataset.nextCursor); navigate(more.url, !more.continuation); } }}
          onOpen={open}
          {query}
          {rows}
          {timeZone}
        />
      {:else if !listError}
        <p class="wt-empty" role="status">Reading tasks…</p>
      {/if}
    {/if}
  </main>
</div>
