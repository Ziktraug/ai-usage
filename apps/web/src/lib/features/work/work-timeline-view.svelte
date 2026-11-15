<script lang="ts">
  import type { WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
  import { createQueries, createQuery } from '@tanstack/svelte-query';
  import { tick } from 'svelte';
  import { browser } from '$app/env';
  import { workThreadDetailQueryOptions, workThreadTimelineQueryOptions } from '../../query/options/work-threads';
  import type { WorkThreadsClient } from '../../rpc/work-threads-client';
  import WorkTimelineBoard from './work-timeline-board.svelte';
  import type { WorkTimelineDataset } from './work-timeline-load';
  import {
    resolveTimelineWindow,
    type TimelineViewState,
    timelineDetailTargets,
    timelineDomain,
    timelineLanes,
    timelineLoadedCopy,
    timelineOverview,
    timelineScale,
    timelineSessionBars,
    timelineViewState,
    timelineViewUrl,
  } from './work-timeline-model';
  import './work-timeline.css';

  const NO_DETAIL_TARGETS: ReturnType<typeof timelineDetailTargets> = { threadIds: [], skipped: 0 };

  interface Props {
    client: Pick<WorkThreadsClient, 'detail' | 'list'>;
    href: (id: string) => string;
    navigate: (url: URL, replaceState?: boolean) => Promise<void>;
    onFilter: (patch: { project?: string | null; search?: string | null }) => Promise<void>;
    onOpen: (event: MouseEvent, id: string) => void;
    /** Called once, after the first render that has tasks to show. */
    onReady: () => void;
    query: WorkThreadListQuery;
    timeZone: string;
    url: URL;
  }

  let { client, href, navigate, onFilter, onOpen, onReady, query, timeZone, url }: Props = $props();

  const filter = $derived({ project: query.project, search: query.search });
  const timeline = createQuery(() => workThreadTimelineQueryOptions(client, filter, { browser, enabled: true }));
  const answered = $derived(timeline.data?.ok ? timeline.data.data : null);
  // A project or search change starts a new read with no answer yet; the last answered timeline
  // stays on screen until it answers, so the toolbar (and the focused search field) is never
  // unmounted for a spinner.
  let lastAnswered = $state<WorkTimelineDataset | null>(null);
  $effect(() => {
    if (answered) {
      lastAnswered = answered;
    }
  });
  const data = $derived(answered ?? lastAnswered);
  // The page restores focus and scroll on a task row: after a reload on a task, or a long stay in
  // it, there is no cached answer and the rows only exist once this read has answered and rendered.
  let ready = false;
  $effect(() => {
    if (data && !ready) {
      ready = true;
      tick().then(onReady);
    }
  });
  const readError = $derived(
    timeline.data && !timeline.data.ok ? timeline.data.error.message : (timeline.error?.message ?? null),
  );

  // Expanding a lane rewrites the URL too: the window and the grouping are read as plain values so
  // that only a change of theirs rebuilds the scale and the lanes.
  const view = $derived(timelineViewState(url.searchParams));
  const grouping = $derived(view.grouping);
  const requestedFrom = $derived(view.window?.from ?? null);
  const requestedTo = $derived(view.window?.to ?? null);
  const domain = $derived(
    data
      ? timelineDomain(
          data.generatedAt,
          timeZone,
          data.rows.map((row) => row.firstActivityAt),
        )
      : null,
  );
  const frame = $derived.by(() => {
    if (!(data && domain)) {
      return null;
    }
    const windowIndexes = resolveTimelineWindow(
      domain,
      requestedFrom !== null && requestedTo !== null ? { from: requestedFrom, to: requestedTo } : null,
    );
    const scale = timelineScale(
      domain.slice(windowIndexes.fromIndex, windowIndexes.toIndex + 1),
      data.generatedAt,
      timeZone,
    );
    return { scale, windowIndexes };
  });
  const lanes = $derived(
    data && frame
      ? timelineLanes({
          grouping,
          now: data.generatedAt,
          rows: data.rows,
          scale: frame.scale,
          sourcesOf: (threadId) => data.rowSources.get(threadId) ?? data.sources,
        })
      : [],
  );
  // Depends on the read and the domain only, never on the window: a brush move does not recount.
  const overview = $derived(data && domain ? timelineOverview(data.rows, domain, timeZone) : []);

  // Session spans live in the task detail; they are only read for the one day drawn by the hour.
  const targets = $derived(
    frame?.scale.resolution === 'hour' ? timelineDetailTargets(lanes, frame.scale) : NO_DETAIL_TARGETS,
  );
  const details = createQueries(() => ({
    queries: targets.threadIds.map((id) => workThreadDetailQueryOptions(client, id, { browser, enabled: true })),
  }));
  const sessionBars = $derived.by(() => {
    const bars = new Map<string, ReturnType<typeof timelineSessionBars>>();
    if (!(data && frame)) {
      return bars;
    }
    for (const [index, id] of targets.threadIds.entries()) {
      const result = details[index]?.data;
      if (result?.ok) {
        bars.set(id, timelineSessionBars(result.data.episodes, frame.scale, data.generatedAt));
      }
    }
    return bars;
  });
  const detail = $derived(
    frame?.scale.resolution === 'hour'
      ? {
          failed: details.filter((result) => (result.data ? !result.data.ok : result.error !== null)).length,
          read: sessionBars.size,
          skipped: targets.skipped,
          targets: targets.threadIds.length + targets.skipped,
        }
      : null,
  );

  // The tasks on screen answer an earlier filter while the current one is read, or after it failed.
  const loadedCopy = $derived.by(() => {
    if (answered) {
      return timelineLoadedCopy(answered, filter);
    }
    return timeline.isFetching ? 'Reading the tasks of this filter…' : 'Showing the last timeline that could be read';
  });

  const changeView = (patch: Partial<TimelineViewState>): Promise<void> => navigate(timelineViewUrl(url, patch), true);
</script>

{#if readError}
  <div class="wt-alert" role="alert">
    <strong>Timeline unavailable</strong>
    <p>{readError} This does not establish that nothing happened.</p>
    <button class="wt-button" onclick={() => timeline.refetch()} type="button">Retry timeline</button>
  </div>
{/if}
{#if data && domain && frame}
  <WorkTimelineBoard
    {detail}
    {domain}
    {href}
    {lanes}
    {loadedCopy}
    now={data.generatedAt}
    {onFilter}
    {onOpen}
    onView={changeView}
    {overview}
    projects={data.projects}
    {query}
    scale={frame.scale}
    {sessionBars}
    sources={data.sources}
    {view}
    windowIndexes={frame.windowIndexes}
  />
{:else if !readError}
  <p class="wt-empty" role="status">Reading the timeline…</p>
{/if}
