<script lang="ts">
  import { shell } from '@ai-usage/design-system/svelte';
  import {
    isWorkThreadId,
    sessionLinkKey,
    type WorkThreadCommand,
    type WorkThreadCommandResult,
    type WorkThreadTaskCommand,
  } from '@ai-usage/report-core/work-thread';
  import { createInfiniteQuery, createQueries, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, tick, untrack } from 'svelte';
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import { displayTitle } from '../../foundation/presentation/display-title';
  import { reportBootstrapQueryOptions } from '../../query/options/report';
  import { workSessionsOptions } from '../../query/options/work';
  import {
    invalidateWorkThreadListQueries,
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
  import WorkDiskView from './work-disk-view.svelte';
  import WorkJiraSync from './work-jira-sync.svelte';
  import { createSyntheticWorkClient, WORK_DEMO_REVISION } from './work-synthetic';
  import WorkThreadDetail, { type HistoryLayout } from './work-thread-detail.svelte';
  import WorkThreadList from './work-thread-list.svelte';
  import type { ThreadPageData } from './work-thread-load';
  import {
    harnessName,
    THREAD_PAGE_WINDOW,
    type ThreadBand,
    type ThreadView,
    threadBandFilter,
    threadListQuery,
    threadMoreUrl,
    threadPageCursors,
    threadSideUrl,
    threadUrl,
    threadView,
    threadViewUrl,
  } from './work-thread-model';
  import WorkThreadPilot from './work-thread-pilot.svelte';
  import { threadListShell, threadSurface } from './work-thread-styles';
  import WorkTimelineView from './work-timeline-view.svelte';
  import './work-threads.css';
  import './work-task-pane.css';
  import './work-thread-pilot.css';

  // One switcher for the four lenses; a URL without `view` shows the first.
  const VIEWS = [
    { view: 'lanes', label: 'Lanes' },
    { view: 'pilot', label: 'Pilot' },
    { view: 'timeline', label: 'Timeline' },
    { view: 'disk', label: 'Disk' },
  ] as const satisfies readonly { view: ThreadView; label: string }[];

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
  const currentUrl = $derived(new URL(page.url.href));
  const taskId = $derived(currentUrl.searchParams.get('task'));
  const view = $derived(threadView(currentUrl.searchParams));
  // `detail=side` keeps the list as the page and shows the task in a pane beside it.
  const side = $derived(taskId !== null && currentUrl.searchParams.get('detail') === 'side');
  const historyLayout = $derived<HistoryLayout>(
    currentUrl.searchParams.get('history') === 'journal' ? 'journal' : 'cascade',
  );
  const setHistoryLayout = (layout: HistoryLayout): Promise<void> => {
    const url = new URL(currentUrl);
    if (layout === 'journal') {
      url.searchParams.set('history', 'journal');
    } else {
      url.searchParams.delete('history');
    }
    return navigate(url, true);
  };
  const query = $derived(threadListQuery(currentUrl.searchParams));
  const cursors = $derived(threadPageCursors(currentUrl.searchParams));
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
  let loadingMore = $state(false);
  const listFetching = $derived(listQueries.some((result) => result.isFetching));
  const moreUnavailable = $derived(listError !== null || answered.length !== cursors.length);
  const loadMore = async (): Promise<void> => {
    if (loadingMore || listFetching || moreUnavailable || !dataset?.nextCursor) {
      return;
    }
    loadingMore = true;
    try {
      const more = threadMoreUrl(currentUrl, dataset.nextCursor);
      await navigate(more.url, !more.continuation);
    } finally {
      loadingMore = false;
    }
  };
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
    navigation.goto(url, { replace: replaceState, reset: false });
  // A row links to the task's full page, so a modified click opens that; a plain click opens the pane.
  const href = (id: string, day?: string): string => threadUrl(currentUrl, id, day);
  const focusRow = (id: string): void => {
    // The id comes from the URL: only a task identifier may enter a selector.
    if (isWorkThreadId(id)) {
      document
        .querySelector<HTMLElement>(`[data-work-thread="${id}"] :is(.wt-task-title, .wt-row-title)`)
        ?.focus({ preventScroll: true });
    }
  };
  /**
   * Opening the pane is one history entry; moving the selection and closing replace it. Back from an
   * open pane therefore closes it, and never walks through every task that was selected.
   */
  const select = (id: string, day?: string): Promise<void> => navigate(threadSideUrl(currentUrl, id, day), side);
  const plainClick = (event: MouseEvent): boolean =>
    !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && event.button === 0;
  /** Closing the pane returns the keyboard to the row it came from; the list has not moved. */
  const closeSide = async (): Promise<void> => {
    const closed = taskId;
    await navigate(threadUrl(currentUrl, null), true);
    await tick();
    if (closed) {
      focusRow(closed);
    }
  };
  const onCloseSide = (event: MouseEvent): void => {
    if (plainClick(event)) {
      event.preventDefault();
      closeSide();
    }
  };
  const keyPane = (event: KeyboardEvent): void => {
    // Escape closes the pane from inside it or from a link of the list that opens it. A field being
    // edited or an open form of the pane keeps it: closing would drop what was typed.
    const target = event.target instanceof Element ? event.target : null;
    const within =
      target?.closest('[data-work-pane], .wt-task-title, .wt-row-title, .wt-next, .wt-day-marks .wt-link') &&
      !target.closest('.wt-inline-panel');
    const editing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement;
    if (event.key === 'Escape' && !event.defaultPrevented && within && !editing) {
      event.preventDefault();
      closeSide();
    }
  };
  const updateFilter = (patch: Partial<ReturnType<typeof threadListQuery>>): Promise<void> => {
    const url = new URL(currentUrl);
    url.searchParams.delete('cursor');
    url.searchParams.delete('start');
    url.searchParams.delete('scroll');
    if ('tab' in patch) {
      url.searchParams.set('tab', patch.tab ?? 'open');
      // Bands are counted within one tab; a filter left behind would hide the other tab's tasks.
      url.searchParams.delete('band');
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
  const viewHref = (target: ThreadView): string => threadViewUrl(currentUrl, target);
  const switchView = async (event: MouseEvent, target: ThreadView): Promise<void> => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    await navigate(viewHref(target));
  };
  const updateBand = (band: ThreadBand | null): Promise<void> => {
    const url = new URL(currentUrl);
    if (band === null) {
      url.searchParams.delete('band');
    } else {
      url.searchParams.set('band', band);
    }
    return navigate(url, true);
  };
  const open = async (event: MouseEvent, id: string, day?: string): Promise<void> => {
    if (!plainClick(event)) {
      return;
    }
    event.preventDefault();
    // Activating the task already shown moves the keyboard into its pane; Escape brings it back.
    if (side && id === taskId && day === undefined) {
      document.querySelector<HTMLElement>('[data-work-pane]')?.focus();
      return;
    }
    await select(id, day);
  };
  /** The Timeline opens a task as a full page and saves its place, as before the pane existed. */
  const openPage = async (event: MouseEvent, id: string, day?: string): Promise<void> => {
    if (!plainClick(event)) {
      return;
    }
    event.preventDefault();
    const saved = new URL(currentUrl);
    saved.searchParams.set('scroll', String(Math.round(window.scrollY)));
    saved.searchParams.set('focus', id);
    await navigate(saved, true);
    await navigate(threadUrl(saved, id, day));
    window.scrollTo(0, 0);
    await tick();
    document.querySelector<HTMLElement>('[data-work-threads]')?.focus();
  };
  /** The full page is its own history entry: the list's place is saved so Back restores it. */
  const openFull = async (event: MouseEvent): Promise<void> => {
    // Read before the first navigation: it removes the task from the URL these values derive from.
    const id = taskId;
    const day = currentUrl.searchParams.get('day') ?? undefined;
    if (!(plainClick(event) && id)) {
      return;
    }
    event.preventDefault();
    const saved = new URL(threadUrl(currentUrl, null), currentUrl);
    saved.searchParams.set('scroll', String(Math.round(window.scrollY)));
    saved.searchParams.set('focus', id);
    await navigate(saved, true);
    await navigate(threadUrl(saved, id, day));
    window.scrollTo(0, 0);
    await tick();
    document.querySelector<HTMLElement>('[data-work-threads]')?.focus();
  };
  const back = async (event: MouseEvent): Promise<void> => {
    if (!plainClick(event)) {
      return;
    }
    event.preventDefault();
    await navigate(threadUrl(currentUrl, null));
    await tick();
    restoreList();
  };
  // The timeline draws its rows after its own read: a restoration that finds no row yet is run
  // again when the view reports its first render.
  let pendingRestore = false;
  const restoreList = (): void => {
    const scroll = Number(currentUrl.searchParams.get('scroll') ?? 0);
    const focus = currentUrl.searchParams.get('focus');
    if (focus && isWorkThreadId(focus)) {
      const title = document.querySelector<HTMLElement>(
        `[data-work-thread="${focus}"] :is(.wt-task-title, .wt-row-title)`,
      );
      title?.focus({ preventScroll: true });
      pendingRestore = view === 'timeline' && title === null;
    }
    window.scrollTo(0, Number.isFinite(scroll) ? Math.max(0, scroll) : 0);
  };
  const restoreTimeline = (): void => {
    if (pendingRestore) {
      restoreList();
      // Cleared after the second attempt, which must not arm a third.
      pendingRestore = false;
    }
  };
  $effect(() => {
    // Leaving the timeline abandons a restoration it never got to run.
    if (view !== 'timeline') {
      pendingRestore = false;
    }
  });
  let previousTask = untrack(() => taskId);
  let previousSide = untrack(() => side);
  $effect(() => {
    const current = taskId;
    // Closing the pane leaves the list where it is; only a return from the full page restores it.
    if (!current && previousTask && hydrated && !previousSide) {
      tick().then(restoreList);
    }
    previousTask = current;
    previousSide = side;
  });
  const command = async (input: WorkThreadCommand) => {
    const result = await clients.threads.command(input);
    const requestedId = 'threadId' in input ? input.threadId : null;
    const id = result.ok ? (result.threadId ?? requestedId) : requestedId;
    if (id) {
      await invalidateWorkThreadQueries(queryClient, id);
    } else if (result.ok) {
      // An intake decision changes no task; only the list (and its intake) is stale.
      await invalidateWorkThreadListQueries(queryClient);
    }
    return result;
  };
  // Task commands always answer with their task; the detail and its undo rely on that shape.
  const taskCommand = async (input: WorkThreadTaskCommand): Promise<WorkThreadCommandResult> => {
    const result = await command(input);
    if (!result.ok) {
      return result;
    }
    if (result.threadId === null) {
      throw new Error('The task command answered without its task.');
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
          title: displayTitle(row.sessionLabel || row.name || 'Untitled session'),
          caption: `${harnessName(row.harness)} · ${row.projectLabel}`,
        },
      ];
    }),
  );
</script>

{#snippet viewSwitch()}
  <nav aria-label="Work views" class="wt-views">
    {#each VIEWS as item (item.view)}
      <a
        aria-current={view === item.view ? 'page' : undefined}
        href={viewHref(item.view)}
        onclick={(event) => switchView(event, item.view)}
        >{item.label}</a
      >
    {/each}
  </nav>
{/snippet}

<svelte:head><title>{detail?.row.thread.title ?? 'My work'} · ai-usage</title></svelte:head>
{#snippet task(
  presentation: 'page' | 'side',
)}
  {#if data.mode !== 'live'}
    <p class="wt-meta">Synthetic demo</p>
  {/if}
  {#if detail}
    {#key detail.row.thread.threadId}
      <WorkThreadDetail
        backHref={threadUrl(currentUrl, null)}
        data={detail}
        fullHref={presentation === 'side' ? href(detail.row.thread.threadId) : null}
        {historyLayout}
        moreSessions={sessions.hasNextPage}
        nextHref={next ? href(next) : null}
        onBack={presentation === 'side' ? onCloseSide : back}
        onCommand={taskCommand}
        onHistoryLayout={setHistoryLayout}
        onMoreSessions={() => loadNextLinkableSessionPage(sessions)}
        onOpenFull={openFull}
        onPickerOpen={() => (pickerOpen = true)}
        {presentation}
        previousHref={previous ? href(previous) : null}
        selectedDay={currentUrl.searchParams.get('day')}
        sessionChoices={choices}
        sessionsError={sessions.error?.message ??
          bootstrapQuery.error?.message ??
          (bootstrapQuery.data && !bootstrapQuery.data.ok ? 'Recent sessions are unavailable.' : null)}
        sessionsLoading={sessions.isFetching || bootstrapQuery.isFetching}
        {timeZone}
      />
    {/key}
  {:else if detailError}
    <div class="wt-empty" role="alert">
      <svelte:element this={presentation === 'side' ? 'h2' : 'h1'}>Task unavailable</svelte:element>
      <p>{detailError}</p>
      <a class="wt-link" href={threadUrl(currentUrl, null)} onclick={presentation === 'side' ? onCloseSide : undefined}
        >{presentation === 'side' ? 'Close' : '← My work'}</a
      ><button class="wt-button" onclick={() => detailQuery.refetch()} type="button">Retry task</button>
    </div>
  {:else}
    <p class="wt-empty" role="status">Reading this task…</p>
    {#if presentation === 'side'}
      <a class="wt-link" href={threadUrl(currentUrl, null)} onclick={onCloseSide}>Close</a>
    {/if}
  {/if}
{/snippet}

<svelte:window onkeydown={side ? keyPane : undefined} />
<div class={taskId && !side ? shell : threadListShell} class:wt-split={side}>
  <main
    class={`${threadSurface} wt-surface`}
    data-route-shell="work"
    data-work-hydrated={hydrated}
    data-work-threads
    tabindex="-1"
    class:wt-focus={Boolean(taskId) && !side}
  >
    {#if data.mode !== 'demo'}
      <WorkJiraSync {timeZone} />
    {/if}
    {#if taskId && !side}
      {@render task('page')}
    {:else if view === 'disk'}
      <WorkDiskView {href} switcher={viewSwitch} threads={clients.threads} {timeZone} />
    {:else}
      {#if view === 'pilot'}
        <header class="wt-pilot-head">
          <h1>My work</h1>
          {@render viewSwitch()}
          <div class="wt-pilot-head-meta">
            {#if data.mode !== 'live'}
              <span>Synthetic demo</span>
            {/if}
            <a class="wt-link" href="/work/sessions">Session intake&nbsp;↗</a>
            <a class="wt-link" href="/work/sessions#work-delegations-heading">Delegation results&nbsp;↗</a>
          </div>
        </header>
      {:else}
        <header class="wt-page-head">
          <div>
            <p class="wt-eyebrow">My work</p>
            <h1>One thread per task.</h1>
            <p class="wt-subtitle">Sessions pass. The follow-up stays, until you end it.</p>
          </div>
          <div class="wt-page-meta">
            {@render viewSwitch()}
            {#if data.mode !== 'live'}
              <span>Synthetic demo</span>
            {/if}
            <a class="wt-link" href="/work/sessions">Session intake&nbsp;↗</a>
            <a class="wt-link" href="/work/sessions#work-delegations-heading">Delegation results&nbsp;↗</a>
          </div>
        </header>
      {/if}
      {#if listError && view !== 'timeline'}
        <div class="wt-alert" role="alert">
          <strong>Tasks unavailable</strong>
          <p>{listError} This does not establish that there are no tasks.</p>
          <button
            class="wt-button"
            onclick={() => {
              for (const result of listQueries) {
                result.refetch();
              }
            }}
            type="button"
          >
            Retry tasks
          </button>
        </div>
      {/if}
      {#if view === 'timeline'}
        <WorkTimelineView
          client={clients.threads}
          {href}
          {navigate}
          onFilter={updateFilter}
          onOpen={openPage}
          onReady={restoreTimeline}
          {query}
          {timeZone}
          url={currentUrl}
        />
      {:else if dataset && view === 'pilot'}
        <WorkThreadPilot
          band={threadBandFilter(currentUrl.searchParams)}
          continuation={cursors.length >= THREAD_PAGE_WINDOW}
          {dataset}
          focusId={currentUrl.searchParams.get('focus')}
          {href}
          loadingMore={loadingMore || listFetching}
          {moreUnavailable}
          onBand={updateBand}
          onCommand={command}
          onFilter={updateFilter}
          onMore={loadMore}
          onOpen={open}
          onSelect={select}
          {query}
          {rows}
          selectedId={side ? taskId : null}
          {timeZone}
        />
      {:else if dataset}
        <WorkThreadList
          continuation={cursors.length >= THREAD_PAGE_WINDOW}
          {dataset}
          grouping={currentUrl.searchParams.get('group') === 'bands' ? 'band' : 'situation'}
          {href}
          loadingMore={loadingMore || listFetching}
          {moreUnavailable}
          onCommand={command}
          onFilter={updateFilter}
          onMore={loadMore}
          onOpen={open}
          onSelect={select}
          {query}
          {rows}
          selectedId={side ? taskId : null}
          {timeZone}
        />
      {:else if !listError}
        <p class="wt-empty" role="status">Reading tasks…</p>
      {/if}
    {/if}
  </main>
  {#if side}
    <aside aria-label="Task detail" class={`${threadSurface} wt-surface wt-pane`} data-work-pane tabindex="-1">
      {@render task('side')}
    </aside>
  {/if}
</div>
