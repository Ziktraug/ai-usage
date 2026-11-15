<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; work-timeline.ssr.test.ts asserts their values. -->
<script lang="ts" module>
  const utcDay = { timeZone: 'UTC', month: 'short', day: 'numeric' } as const;
  const dayFormatter = new Intl.DateTimeFormat('en-US', utcDay);
  const datedDayFormatter = new Intl.DateTimeFormat('en-US', { ...utcDay, year: 'numeric' });
  const singleDayFormatter = new Intl.DateTimeFormat('en-US', { ...utcDay, weekday: 'short', year: 'numeric' });
  /** A calendar key names a day, not an instant: noon UTC keeps it on that day whatever the zone. */
  const dayOf = (key: string): Date => new Date(`${key}T12:00:00Z`);

  /** Day and quarter-day columns are direct day controls up to this many (ADR 0013). */
  const DAY_CONTROL_MAX_COLUMNS = 62;
  /** A collapsed project prints its pull request numbers only while they stay readable. */
  const LANE_LABEL_MAX_BARS = 8;
  const HEAT_UNITS = { day: 'day', 'quarter-day': '6 h', hour: 'hour' } as const;
  /** Tone, name, and whether the sample carries the end cap of a pull request that reaches now. */
  const LEGEND_PULL_REQUESTS = [
    ['merged', 'Merged', false],
    ['open', 'Open', true],
    ['approved', 'Approved', true],
    ['draft', 'Draft', false],
    ['blocked', 'Blocked or failing checks', false],
    ['closed', 'Closed', false],
    ['unknown', 'State unknown', false],
  ] as const;
</script>

<script lang="ts">
  import type { WorkThreadListQuery, WorkThreadSourceStatus } from '@ai-usage/report-core/work-thread-view';
  import { tick } from 'svelte';
  import WorkThreadSources from './work-thread-sources.svelte';
  import WorkTimelineBrush from './work-timeline-brush.svelte';
  import {
    activeTimelineZoom,
    TIMELINE_CAPPED_COPY,
    TIMELINE_DETAIL_MAX,
    TIMELINE_HEAT_LEGEND,
    TIMELINE_ZOOMS,
    type TimelineLane,
    type TimelineScale,
    type TimelineSessionBar,
    type TimelineTask,
    type TimelineTrack,
    type TimelineViewState,
    type TimelineWindow,
    type TimelineWindowIndexes,
    timelineShiftWindow,
    timelineTodayWindow,
    timelineZoomWindow,
  } from './work-timeline-model';
  import WorkTimelineTrack from './work-timeline-track.svelte';

  interface Props {
    /** Hour resolution: how many of the tasks that may have sessions that day had their spans read. */
    detail: {
      readonly failed: number;
      readonly read: number;
      readonly skipped: number;
      readonly targets: number;
    } | null;
    /** Every day the window can reach, oldest first. */
    domain: readonly string[];
    href: (id: string) => string;
    lanes: readonly TimelineLane[];
    /** What the read loaded, or that the tasks shown still answer an earlier filter. */
    loadedCopy: string;
    /** The instant of the read: the source statuses are aged against it. */
    now: string;
    onFilter: (patch: { project?: string | null; search?: string | null }) => Promise<void>;
    onOpen: (event: MouseEvent, id: string) => void;
    onView: (patch: Partial<TimelineViewState>) => Promise<void>;
    /** Sessions started per domain day, for the brush. */
    overview: readonly number[];
    projects: readonly string[];
    query: Pick<WorkThreadListQuery, 'project' | 'search'>;
    scale: TimelineScale;
    /** Hour resolution: the session spans of the tasks whose detail was read, by task. */
    sessionBars: ReadonlyMap<string, { readonly bars: readonly TimelineSessionBar[]; readonly rows: number }>;
    /** The source statuses of the read, the worst of its pages: shown above the board. */
    sources: readonly WorkThreadSourceStatus[];
    view: TimelineViewState;
    windowIndexes: TimelineWindowIndexes;
  }

  let {
    detail,
    domain,
    href,
    lanes,
    loadedCopy,
    now,
    onFilter,
    onOpen,
    onView,
    overview,
    projects,
    query,
    scale,
    sessionBars,
    sources,
    view,
    windowIndexes,
  }: Props = $props();

  const activeZoom = $derived(activeTimelineZoom(windowIndexes.toIndex - windowIndexes.fromIndex + 1));
  const atStart = $derived(windowIndexes.fromIndex <= 0);
  const atEnd = $derived(windowIndexes.toIndex >= domain.length - 1);
  const windowText = $derived.by(() => {
    const first = scale.days[0];
    const last = scale.days.at(-1);
    if (!(first && last)) {
      return '';
    }
    if (first === last) {
      return singleDayFormatter.format(dayOf(first));
    }
    const sameYear = first.slice(0, 4) === last.slice(0, 4);
    return `${(sameYear ? dayFormatter : datedDayFormatter).format(dayOf(first))} – ${datedDayFormatter.format(dayOf(last))}`;
  });
  const count = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`;
  const toggled = (keys: readonly string[], key: string): readonly string[] =>
    keys.includes(key) ? keys.filter((value) => value !== key) : [...keys, key];
  // A task row draws each pull request's milestones as glyphs: the table names them after the bar.
  const pullRequestText = (track: TimelineTrack, milestones: boolean): string => {
    const parts = track.pullRequests.map((bar) =>
      milestones && bar.milestones.length > 0
        ? `${bar.description} (${bar.milestones.map((milestone) => milestone.label).join('; ')})`
        : bar.description,
    );
    if (track.hiddenPullRequests > 0) {
      parts.push(`+${track.hiddenPullRequests} more`);
    }
    if (track.undatedPullRequests > 0) {
      parts.push(`${track.undatedPullRequests} without dates`);
    }
    return parts.length > 0 ? parts.join(', ') : 'None';
  };
  const laneStatus = (lane: TimelineLane): string => `${count(lane.tasks.length, 'task', 'tasks')} · ${lane.status}`;
  // By the hour, a session started before the day and still going has a span but no start in the
  // window: its task is listed with the others that have something to show, not behind the toggle.
  const shown = (task: TimelineTask): boolean =>
    task.track.active ||
    (scale.resolution === 'hour' && (sessionBars.get(task.row.thread.threadId)?.bars.length ?? 0) > 0);
  const activeTasks = (lane: TimelineLane): readonly TimelineTask[] => lane.tasks.filter(shown);
  const idleTasks = (lane: TimelineLane): readonly TimelineTask[] => lane.tasks.filter((task) => !shown(task));
  /** The tasks an expanded lane lists: those with something in the window, then the others on request. */
  const listedTasks = (lane: TimelineLane): readonly TimelineTask[] =>
    view.quiet.includes(lane.key) ? [...activeTasks(lane), ...idleTasks(lane)] : activeTasks(lane);
  const statusText = $derived.by(() => {
    const parts = [loadedCopy, windowText];
    if (detail) {
      parts.push(
        `session spans read for ${detail.read} of ${count(detail.targets, 'task', 'tasks')} that may have sessions that day`,
      );
      if (detail.skipped > 0) {
        parts.push(`${detail.skipped} not read (limit ${TIMELINE_DETAIL_MAX})`);
      }
      if (detail.failed > 0) {
        parts.push(`${detail.failed} could not be read`);
      }
    }
    return parts.join(' · ');
  });
  // At an edge of the range the move is refused here: the button stays focusable (aria-disabled).
  const moveWindow = async (refused: boolean, next: () => TimelineWindow): Promise<void> => {
    if (!refused) {
      await onView({ window: next() });
    }
  };

  const dayControls = $derived(scale.resolution !== 'hour' && scale.columns.length <= DAY_CONTROL_MAX_COLUMNS);
  // What a day control leads to, in its name: the heat under it says so by its tint alone.
  const columnSessions = $derived(
    scale.columns.map((_, index) => lanes.reduce((total, lane) => total + (lane.track.heat[index]?.count ?? 0), 0)),
  );
  // One tab stop for the whole scale; today's side first, then wherever the operator last was.
  let rovingColumn = $state<number | null>(null);
  const tabColumn = $derived(Math.min(rovingColumn ?? scale.columns.length - 1, scale.columns.length - 1));
  let ticks = $state<HTMLElement>();
  const columnForKey = (key: string, index: number): number | null => {
    const last = scale.columns.length - 1;
    switch (key) {
      case 'ArrowLeft':
        return Math.max(0, index - 1);
      case 'ArrowRight':
        return Math.min(last, index + 1);
      case 'Home':
        return 0;
      case 'End':
        return last;
      default:
        return null;
    }
  };
  const keyColumns = (event: KeyboardEvent, index: number): void => {
    const next = columnForKey(event.key, index);
    if (next === null) {
      return;
    }
    event.preventDefault();
    rovingColumn = next;
    ticks?.querySelectorAll<HTMLElement>('button')[next]?.focus();
  };
  // One day is drawn by the hour, where the scale has no day controls left: focus moves to the
  // zoom that is now pressed instead of being dropped with the removed button.
  const zoomToDay = async (dayKey: string): Promise<void> => {
    await onView({ window: { from: dayKey, to: dayKey } });
    await tick();
    document.getElementById('wtl-zoom-24h')?.focus();
  };
</script>

{#snippet taskRow(
  task: TimelineTask,
)}
  {@const id = task.row.thread.threadId}
  <div class="wtl-row wtl-task" data-work-thread={id} class:wtl-quiet={!shown(task)}>
    <div class="wtl-name">
      <a
        class="wt-task-title wtl-task-title"
        href={href(id)}
        onclick={(event) => onOpen(event, id)}
        title={task.row.thread.title}
        >{task.row.thread.title}</a
      >
      <p class="wt-meta wtl-task-meta">
        <span class="wt-hint" data-hint={task.hint}><span aria-hidden="true">●</span> {task.hintLabel}</span>
        {#if view.grouping === 'attention'}
          <span title={task.row.thread.projectLabel ?? undefined}>{task.project}</span>
        {/if}
        {#if task.track.capped}
          <span class="wtl-partial" title={TIMELINE_CAPPED_COPY}>partial</span>
        {/if}
        <span>{count(task.row.sessionCount, 'linked session', 'linked sessions')}</span>
      </p>
    </div>
    <div class="wtl-track-cell">
      <WorkTimelineTrack
        labels
        milestones
        {scale}
        sessions={scale.resolution === 'hour' ? (sessionBars.get(id) ?? null) : null}
        track={task.track}
      />
    </div>
  </div>
{/snippet}

<div class="wtl-toolbar">
  <fieldset aria-label="Zoom" class="wtl-group">
    {#each TIMELINE_ZOOMS as zoom (zoom.id)}
      <button
        aria-pressed={activeZoom === zoom.id ? 'true' : 'false'}
        id={`wtl-zoom-${zoom.id}`}
        onclick={() => onView({ window: timelineZoomWindow(domain, windowIndexes, zoom.days) })}
        type="button"
      >
        {zoom.label}
      </button>
    {/each}
  </fieldset>
  <!-- aria-disabled, not disabled: a button that reaches the edge of the range keeps the focus. -->
  <fieldset aria-label="Move the window" class="wtl-group">
    <button
      aria-disabled={atStart ? 'true' : 'false'}
      onclick={() => moveWindow(atStart, () => timelineShiftWindow(domain, windowIndexes, -1))}
      type="button"
    >
      ‹ Earlier
    </button>
    <button
      aria-disabled={atEnd ? 'true' : 'false'}
      onclick={() => moveWindow(atEnd, () => timelineShiftWindow(domain, windowIndexes, 1))}
      type="button"
    >
      Later ›
    </button>
    <button
      aria-disabled={atEnd ? 'true' : 'false'}
      onclick={() => moveWindow(atEnd, () => timelineTodayWindow(domain, windowIndexes))}
      type="button"
    >
      Today
    </button>
  </fieldset>
  <fieldset aria-label="Group by" class="wtl-group">
    <button
      aria-pressed={view.grouping === 'project' ? 'true' : 'false'}
      onclick={() => onView({ grouping: 'project' })}
      type="button"
    >
      Project
    </button>
    <button
      aria-pressed={view.grouping === 'attention' ? 'true' : 'false'}
      onclick={() => onView({ grouping: 'attention' })}
      type="button"
    >
      Attention
    </button>
  </fieldset>
  <div class="wtl-group">
    <button onclick={() => onView({ open: lanes.map((lane) => lane.key) })} type="button">Expand all</button>
    <button onclick={() => onView({ open: [] })} type="button">Collapse all</button>
  </div>
  <div class="wt-filters wtl-filters">
    <label class="wt-sr" for="work-task-project">Project</label>
    <select
      class="wt-input"
      id="work-task-project"
      onchange={(event) => onFilter({ project: event.currentTarget.value || null })}
      value={query.project ?? ''}
    >
      <option value="">All projects</option>
      {#each projects as project}
        <option value={project}>{project}</option>
      {/each}
    </select>
    <label class="wt-sr" for="work-task-search">Search tasks</label>
    <input
      class="wt-input"
      id="work-task-search"
      maxlength="200"
      oninput={(event) => onFilter({ search: event.currentTarget.value || null })}
      placeholder="Task, PR, ticket, branch…"
      type="search"
      value={query.search ?? ''}
    >
  </div>
</div>
<p class="wtl-status" role="status">{statusText}</p>
<WorkThreadSources {now} {sources} timeZone={scale.timeZone} />
<WorkTimelineBrush {domain} onChange={(window) => onView({ window })} {overview} selection={windowIndexes} />

<section aria-label="Tasks on a time axis" class="wtl-board" style={`--wtl-cols: ${scale.columns.length}`}>
  {#if lanes.length === 0}
    <div class="wt-empty">
      <h2>No tasks in this view</h2>
      <p>Try another project or search. Session intake remains available.</p>
      {#if query.project || query.search}
        <button class="wt-button" onclick={() => onFilter({ project: null, search: null })} type="button">
          Clear filters
        </button>
      {/if}
      <a class="wt-link" href="/work/sessions">Browse sessions</a>
    </div>
  {:else}
    <div aria-hidden="true" class="wtl-gridlines">
      {#each scale.columns as column, index (column.key)}
        {#if column.major}
          <span style={`left: ${(index / scale.columns.length) * 100}%`}></span>
        {/if}
      {/each}
    </div>
    {#if scale.now !== null}
      <div aria-hidden="true" class="wtl-now">
        <span class="wtl-now-line" style={`left: ${scale.now * 100}%`} class:wtl-now-end={scale.now > 0.9}
          ><span class="wtl-now-label">Now</span></span
        >
      </div>
    {/if}
    <div class="wtl-row wtl-head">
      <div class="wtl-name">
        {view.grouping === 'project' ? 'Project · latest activity first' : 'Attention · your move first'}
      </div>
      <div class="wtl-track-cell">
        <div class="wtl-scale">
          <div class="wtl-scale-groups">
            {#each scale.groups as group (group.start)}
              <span style={`grid-column: ${group.start} / span ${group.span}`}><span>{group.label}</span></span>
            {/each}
          </div>
          {#if dayControls}
            <fieldset aria-label="Zoom to a day" class="wtl-scale-ticks" bind:this={ticks}>
              {#each scale.columns as column, index (column.key)}
                <button
                  aria-label={`${column.label}: ${count(columnSessions[index] ?? 0, 'session', 'sessions')} started. Zoom to this day.`}
                  onclick={() => zoomToDay(column.dayKey)}
                  onfocus={() => (rovingColumn = index)}
                  onkeydown={(event) => keyColumns(event, index)}
                  tabindex={index === tabColumn ? 0 : -1}
                  title={column.label}
                  type="button"
                  class:wtl-major={column.major}
                  class:wtl-today={column.today}
                >
                  {column.tick ?? ''}
                </button>
              {/each}
            </fieldset>
          {:else}
            <div class="wtl-scale-ticks">
              {#each scale.columns as column, index (column.key)}
                {#if column.tick !== null}
                  <span style={`grid-column: ${index + 1}`}>{column.tick}</span>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
    {#each lanes as lane, laneIndex (lane.key)}
      {@const expanded = view.open.includes(lane.key)}
      {@const idle = idleTasks(lane)}
      <section aria-label={lane.label} class="wtl-lane">
        <div class="wtl-row wtl-lane-head">
          <div class="wtl-name">
            <button
              aria-controls={`wtl-lane-${laneIndex}`}
              aria-expanded={expanded ? 'true' : 'false'}
              class="wtl-lane-toggle"
              onclick={() => onView({ open: toggled(view.open, lane.key) })}
              type="button"
            >
              <span aria-hidden="true" class="wtl-chevron">›</span>
              <span class="wtl-lane-label" title={lane.key}>{lane.label}</span>
              {#if lane.track.capped}
                <span class="wtl-partial" title={TIMELINE_CAPPED_COPY}>partial</span>
              {/if}
              <span class="wt-meta" title={laneStatus(lane)}>{laneStatus(lane)}</span>
            </button>
          </div>
          <div class="wtl-track-cell">
            <WorkTimelineTrack
              labels={lane.track.pullRequests.length <= LANE_LABEL_MAX_BARS}
              {scale}
              track={lane.track}
            />
          </div>
        </div>
        <div class="wtl-tasks" hidden={!expanded} id={`wtl-lane-${laneIndex}`}>
          {#if expanded}
            {#each activeTasks(lane) as task (task.row.thread.threadId)}
              {@render taskRow(task)}
            {/each}
            {#if idle.length > 0}
              <div class="wtl-quiet-row">
                <button
                  aria-expanded={view.quiet.includes(lane.key) ? 'true' : 'false'}
                  class="wtl-quiet-toggle"
                  onclick={() => onView({ quiet: toggled(view.quiet, lane.key) })}
                  type="button"
                >
                  <span aria-hidden="true" class="wtl-chevron">›</span>
                  {count(idle.length, 'task', 'tasks')}
                  with no session started and no pull request in this window
                </button>
              </div>
              {#if view.quiet.includes(lane.key)}
                {#each idle as task (task.row.thread.threadId)}
                  {@render taskRow(task)}
                {/each}
              {/if}
            {/if}
          {/if}
        </div>
      </section>
    {/each}
  {/if}
</section>

{#if lanes.length > 0}
  <div class="wtl-legend">
    <div>
      <span>Sessions started per {HEAT_UNITS[scale.resolution]}</span>
      {#each TIMELINE_HEAT_LEGEND as label, index (label)}
        <span><span aria-hidden="true" class="wtl-cell" data-level={index + 1}></span> {label}</span>
      {/each}
      {#each LEGEND_PULL_REQUESTS as [tone, label, open] (tone)}
        <span
          ><span aria-hidden="true" class="wtl-pr" data-tone={tone} class:wtl-open={open}></span>
          {label}</span
        >
      {/each}
      <span><span aria-hidden="true" class="wtl-now-sample"></span> Now</span>
      {#if scale.resolution === 'hour'}
        <span
          ><span aria-hidden="true" class="wtl-session-sample"></span>
          Session bar: first to last observed activity, pauses included · thin strip: delegated sessions</span
        >
      {/if}
    </div>
    <p>Sessions are placed at their start. Delegated sessions are counted on the task, not in the strip.</p>
  </div>
  <details class="wtl-table">
    <summary>Timeline as a table</summary>
    <table>
      <caption>
        {windowText}
      </caption>
      <thead>
        <tr>
          <th scope="col">{view.grouping === 'project' ? 'Project' : 'Attention'} or task</th>
          <th scope="col">Tasks</th>
          <th scope="col">Sessions started</th>
          <th scope="col">Pull requests</th>
          <th scope="col">Summary</th>
        </tr>
      </thead>
      <tbody>
        {#each lanes as lane (lane.key)}
          <tr>
            <th scope="row">{lane.label}</th>
            <td>{lane.tasks.length}</td>
            <td>{lane.track.sessions}</td>
            <td>{pullRequestText(lane.track, false)}</td>
            <td>{lane.track.summary}</td>
          </tr>
          {#if view.open.includes(lane.key)}
            {#each listedTasks(lane) as task (task.row.thread.threadId)}
              <tr class="wtl-table-task">
                <th scope="row">{task.row.thread.title}</th>
                <td></td>
                <td>{task.track.sessions}</td>
                <td>{pullRequestText(task.track, true)}</td>
                <td>{task.track.summary}</td>
              </tr>
            {/each}
          {/if}
        {/each}
      </tbody>
    </table>
  </details>
{/if}
