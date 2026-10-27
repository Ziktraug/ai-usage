<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type {
    WorkIntakeCommandResult,
    WorkThreadCommand,
    WorkThreadCommandResult,
  } from '@ai-usage/report-core/work-thread';
  import type {
    WorkThreadListDataset,
    WorkThreadListQuery,
    WorkThreadRow,
  } from '@ai-usage/report-core/work-thread-view';
  import { tick } from 'svelte';
  import WorkCombineSuggestions from './work-combine-suggestions.svelte';
  import WorkHarnessGlyph from './work-harness-glyph.svelte';
  import WorkJiraIntake from './work-jira-intake.svelte';
  import WorkThreadArtifacts from './work-thread-artifacts.svelte';
  import {
    bucketThreadMarks,
    groupThreadRows,
    groupThreadRowsBySituation,
    harnessName,
    threadDate,
    threadSituationCopy,
    threadTime,
    threadTimeline,
  } from './work-thread-model';
  import WorkThreadSources from './work-thread-sources.svelte';

  let {
    dataset,
    rows,
    query,
    timeZone,
    href,
    onOpen,
    onFilter,
    onMore,
    onCommand,
    loadingMore = false,
    continuation = false,
  }: {
    dataset: WorkThreadListDataset;
    rows: readonly WorkThreadRow[];
    query: WorkThreadListQuery;
    timeZone: string;
    href: (id: string, day?: string) => string;
    onOpen: (event: MouseEvent, id: string, day?: string) => void;
    onFilter: (patch: Partial<WorkThreadListQuery>) => Promise<void>;
    onMore: () => void;
    onCommand: (command: WorkThreadCommand) => Promise<WorkThreadCommandResult | WorkIntakeCommandResult>;
    loadingMore?: boolean;
    continuation?: boolean;
  } = $props();
  const timeline = $derived(
    threadTimeline(
      dataset.generatedAt,
      timeZone,
      rows.map((row) => row.firstActivityAt),
    ),
  );
  const dayIndex = $derived(new Map(timeline.map((day, index) => [day.key, index])));
  // Each month spans its own columns, so its pinned label stays readable wherever the lane scrolls.
  const months = $derived(
    timeline.flatMap((day, index) => {
      if (day.month === null) {
        return [];
      }
      const next = timeline.findIndex((later, laterIndex) => laterIndex > index && later.month !== null);
      return [{ label: day.month, start: index + 1, span: (next === -1 ? timeline.length : next) - index }];
    }),
  );
  // Mondays draw the stronger week line; the offset aligns the repeating background to them.
  const weekOffset = $derived(
    Math.max(
      timeline.findIndex((day) => day.weekStart),
      0,
    ),
  );
  let board = $state<HTMLElement>();
  let pinnedToToday = true;
  // Today sits at the right edge on load and when the range grows; scrolling back is the operator's.
  $effect(() => {
    if (board && timeline.length && pinnedToToday) {
      board.scrollLeft = board.scrollWidth;
    }
  });
  const onBoardScroll = (): void => {
    if (board) {
      pinnedToToday = board.scrollLeft + board.clientWidth >= board.scrollWidth - 2;
    }
  };
  let groupByProject = $state(false);
  const situations = $derived(
    new Map(
      rows.map((row) => [
        row.thread.threadId,
        threadSituationCopy(row, dataset.generatedAt, dataset.sources, timeZone),
      ]),
    ),
  );
  const situationOf = (row: WorkThreadRow) =>
    situations.get(row.thread.threadId) ?? threadSituationCopy(row, dataset.generatedAt, dataset.sources, timeZone);
  const groups = $derived.by((): readonly { project: string; note?: string; tasks: readonly WorkThreadRow[] }[] => {
    if (groupByProject) {
      return groupThreadRows(rows);
    }
    return groupThreadRowsBySituation(rows, (row) => situationOf(row).hint);
  });
  let selectedMarks = $state<{ threadId: string; day: string } | null>(null);
  const closeMarks = (): void => {
    if (selectedMarks) {
      document.getElementById(`wt-mark-${selectedMarks.threadId}-${selectedMarks.day}`)?.focus();
    }
    selectedMarks = null;
  };
  // The selected tab keeps focus across the navigation that loads its list (APG tabs pattern).
  const keyTabs = async (event: KeyboardEvent): Promise<void> => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    let tab: 'open' | 'done' = query.tab === 'open' ? 'done' : 'open';
    if (event.key === 'Home') {
      tab = 'open';
    }
    if (event.key === 'End') {
      tab = 'done';
    }
    await onFilter({ tab });
    await tick();
    document.getElementById(`work-tab-${tab}`)?.focus();
  };
</script>

<div class="wt-toolbar">
  <div aria-label="Personal follow-up" class="wt-tabs" role="tablist">
    {#each ['open', 'done'] as tab}
      <button
        aria-controls="work-task-panel"
        aria-selected={query.tab === tab ? 'true' : 'false'}
        data-tab={tab}
        id={`work-tab-${tab}`}
        onclick={() => onFilter({ tab: tab === 'done' ? 'done' : 'open' })}
        onkeydown={keyTabs}
        role="tab"
        tabindex={query.tab === tab ? 0 : -1}
        type="button"
      >
        {tab === 'done' ? 'Done' : 'Following'}
        <span class="wt-count">{tab === 'done' ? dataset.counts.done : dataset.counts.open}</span>
      </button>
    {/each}
  </div>
  <div class="wt-filters">
    <label class="wt-switch"><input type="checkbox" bind:checked={groupByProject}>Group by project</label>
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
    <label class="wt-sr" for="work-task-project">Project</label>
    <select
      class="wt-input"
      id="work-task-project"
      onchange={(event) => onFilter({ project: event.currentTarget.value || null })}
      value={query.project ?? ''}
    >
      <option value="">All projects</option>
      {#each dataset.projects as project}
        <option value={project}>{project}</option>
      {/each}
    </select>
  </div>
</div>
<WorkThreadSources now={dataset.generatedAt} sources={dataset.sources} {timeZone} />
{#if query.tab === 'open'}
  <WorkCombineSuggestions
    items={dataset.combineSuggestions.items}
    {onCommand}
    truncated={dataset.combineSuggestions.truncated}
  />
  <WorkJiraIntake
    items={dataset.jiraIntake.items}
    now={dataset.generatedAt}
    {onCommand}
    tasks={rows.filter((row) => row.thread.followState !== 'done')}
    {timeZone}
    truncated={dataset.jiraIntake.truncated}
  />
{/if}

<div aria-labelledby={`work-tab-${query.tab}`} id="work-task-panel" role="tabpanel">
  <!-- One horizontal scroller keeps every lane aligned with the scale; task and "what's left" stay pinned.
       Focusing a task, a day or "what's left" scrolls it into view, and arrow keys then scroll the lane. -->
  <section
    aria-label="Tasks and their activity timeline, scrolls back in time"
    class="wt-board"
    onscroll={onBoardScroll}
    style={`--wt-days: ${timeline.length}; --wt-week-offset: ${weekOffset}`}
    bind:this={board}
  >
    <div aria-hidden="true" class="wt-board-head">
      <span class="wt-col-task">Task · latest activity first ↓</span>
      <div class="wt-scale">
        {#each months as month (month.start)}
          <span class="wt-scale-month" style={`grid-column: ${month.start} / span ${month.span}`}
            ><span>{month.label}</span></span
          >
        {/each}
        {#each timeline as day, index}
          <!-- A Monday right before today would collide with the "Today" label. -->
          {#if day.today || (day.weekStart && index < timeline.length - 2)}
            <span class="wt-scale-day" style={`grid-column: ${index + 1}`} class:wt-today={day.today}
              >{day.today ? 'Today' : day.dayOfMonth}</span
            >
          {/if}
        {/each}
      </div>
      <span class="wt-col-next">What's left</span>
    </div>
    {#each groups as group (group.project)}
      <section aria-label={`${group.project} tasks`}>
        <h2 class="wt-project">
          {group.project}
          <span
            >{group.tasks.length}
            {group.tasks.length === 1 ? 'task' : 'tasks'}{group.note ? ` · ${group.note}` : ''}</span
          >
        </h2>
        {#each group.tasks as row (row.thread.threadId)}
          {@const situation = situationOf(row)}
          {@const buckets = bucketThreadMarks(row.marks, timeZone)}
          <article
            class="wt-task-row"
            data-work-thread={row.thread.threadId}
            class:wt-waiting={row.thread.followState === 'waiting'}
          >
            <div class="wt-task-summary">
              <a
                aria-label={row.thread.title}
                class="wt-task-title"
                href={href(row.thread.threadId)}
                onclick={(event) => onOpen(event, row.thread.threadId)}
                title={row.thread.title}
              >
                <strong>{row.thread.title}</strong>
              </a>
              <p class="wt-meta">
                {row.thread.projectLabel ?? 'No project'}
                · {row.sessionCount} linked
                {row.sessionCount === 1 ? 'session' : 'sessions'}{row.delegatedSessionCount > 0
                  ? ` · ${row.delegatedSessionCount} delegated`
                  : ''}{row.combinedThreads.length > 0 ? ` · combines ${row.combinedThreads.length + 1} tasks` : ''}
              </p>
              <WorkThreadArtifacts now={dataset.generatedAt} {row} {timeZone} />
              <p class="wt-meta">
                Updated
                <time datetime={row.lastActivityAt}
                  >{threadDate(row.lastActivityAt, timeZone, false, dataset.generatedAt)}
                  · {threadTime(row.lastActivityAt, timeZone)}</time
                >
              </p>
            </div>
            <fieldset aria-label={`Activity of ${row.thread.title}`} class="wt-lane">
              <span aria-hidden="true" class="wt-lane-today"></span>
              {#each [...buckets] as [dayKey, marks] (dayKey)}
                {@const index = dayIndex.get(dayKey)}
                {@const day = index === undefined ? undefined : timeline[index]}
                {#if day && index !== undefined}
                  {@const sessions = marks.filter((mark) => mark.kind === 'session')}
                  {@const selected = selectedMarks?.threadId === row.thread.threadId && selectedMarks.day === day.key}
                  {@const description = `${day.label}: ${sessions.length} sessions, ${marks.length - sessions.length} work events. Show activity.`}
                  <button
                    aria-controls={selected ? `wt-marks-${row.thread.threadId}-${day.key}` : undefined}
                    aria-expanded={selected ? 'true' : 'false'}
                    aria-label={description}
                    class="wt-day-button"
                    id={`wt-mark-${row.thread.threadId}-${day.key}`}
                    onclick={() => (selectedMarks = selected ? null : { threadId: row.thread.threadId, day: day.key })}
                    onkeydown={(event) => {
                      if (event.key === 'Escape') {
                        closeMarks();
                      }
                    }}
                    style={`grid-column: ${index + 1}`}
                    title={description}
                    type="button"
                    class:wt-today={day.today}
                  >
                    {#if sessions.length}
                      <span
                        aria-hidden="true"
                        class="wt-mark"
                        data-harness={sessions.length === 1 ? sessions[0]?.harness : ''}
                        >{#if sessions.length > 1}
                          {sessions.length}
                        {:else}
                          <WorkHarnessGlyph harness={sessions[0]?.harness ?? null} />
                        {/if}</span
                      >
                    {/if}
                    {#if marks.length > sessions.length}
                      <span aria-hidden="true" class="wt-mark wt-event-mark"></span>
                    {/if}
                  </button>
                {/if}
              {/each}
            </fieldset>
            <a
              aria-label={`What's left for ${row.thread.title}: ${situation.headline}`}
              class="wt-next"
              href={href(row.thread.threadId)}
              onclick={(event) => onOpen(event, row.thread.threadId)}
            >
              <span class="wt-hint" data-hint={situation.hint}
                ><span aria-hidden="true">●</span>
                {situation.label}
                {#if situation.remainders.some((remainder) => remainder.kind === 'source-stale')}
                  <span class="wt-stale" title="Some source evidence is stale">Stale</span>
                {/if}</span
              >
              <strong>{situation.headline}</strong><small>{situation.caption}</small>
            </a>
            {#if selectedMarks?.threadId === row.thread.threadId}
              {@const dayMarks = buckets.get(selectedMarks.day) ?? []}
              <section
                aria-label={`Activity on ${selectedMarks.day}`}
                class="wt-day-marks"
                id={`wt-marks-${row.thread.threadId}-${selectedMarks.day}`}
              >
                <div>
                  <strong>{selectedMarks.day} · {row.thread.title}</strong
                  ><button aria-label="Close day activity" class="wt-button" onclick={closeMarks} type="button">
                    ×
                  </button>
                </div>
                <ul>
                  {#each dayMarks as mark}
                    <li>
                      <time datetime={mark.at}>{threadTime(mark.at, timeZone)}</time>
                      · {mark.kind === 'session' ? `${harnessName(mark.harness ?? 'Session')} · ` : ''}{mark.label}
                    </li>
                  {/each}
                </ul>
                <a
                  class="wt-link"
                  href={href(row.thread.threadId, selectedMarks.day)}
                  onclick={(event) => onOpen(event, row.thread.threadId, selectedMarks?.day)}
                  >Open task for this day →</a
                >
              </section>
            {/if}
          </article>
        {/each}
      </section>
    {:else}
      <div class="wt-empty">
        <h2>
          {query.tab === 'done' ? 'No ended follow-ups here' : 'No tasks in this view'}
        </h2>
        <p>Try another project or search. Session intake remains available.</p>
        {#if query.project || query.search}
          <button class="wt-button" onclick={() => onFilter({ project: null, search: null })} type="button">
            Clear filters
          </button>
        {/if}
        <a class="wt-link" href="/work/sessions">Browse sessions</a>
      </div>
    {/each}
  </section>
  {#if dataset.nextCursor}
    <div class="wt-more">
      {#if continuation}
        <p class="wt-meta">
          {rows.length}
          tasks loaded. Continue in a new page; browser Back keeps this view.
        </p>
      {/if}
      <button class="wt-button" disabled={loadingMore} onclick={onMore} type="button">
        {#if loadingMore}
          Loading…
        {:else if continuation}
          Continue to next page
        {:else}
          Load more
        {/if}
      </button>
    </div>
  {/if}
</div>
<div class="wt-legend">
  <div>
    <span
      ><span class="wt-glyph" data-harness="claude"><WorkHarnessGlyph harness="claude" size={10} /></span>
      Claude session</span
    ><span
      ><span class="wt-glyph" data-harness="codex"><WorkHarnessGlyph harness="codex" size={10} /></span>
      Codex session</span
    ><span><span class="wt-glyph">2</span> Several sessions that day</span><span>○ Work event</span>
  </div>
  <span>Placed by day · open a mark for times and episode spans</span>
</div>
<p class="wt-quiet">
  “Done” means your follow-up has ended. A session ending, a PR merging and a ticket closing remain separate facts.
</p>
