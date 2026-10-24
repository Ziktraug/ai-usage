<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type {
    WorkThreadListDataset,
    WorkThreadListQuery,
    WorkThreadRow,
  } from '@ai-usage/report-core/work-thread-view';
  import { tick } from 'svelte';
  import {
    bucketThreadMarks,
    groupThreadRows,
    harnessGlyph,
    threadRefs,
    threadSituationCopy,
    threadTime,
    threadWeek,
  } from './work-thread-model';

  let {
    dataset,
    rows,
    query,
    timeZone,
    href,
    onOpen,
    onFilter,
    onMore,
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
    loadingMore?: boolean;
    continuation?: boolean;
  } = $props();
  const week = $derived(threadWeek(dataset.generatedAt, timeZone));
  const groups = $derived(groupThreadRows(rows));
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

<div aria-labelledby={`work-tab-${query.tab}`} id="work-task-panel" role="tabpanel">
  <div class="wt-board">
    <div aria-hidden="true" class="wt-board-head">
      <span>Task</span>
      <div class="wt-week-scale">
        {#each week as day}
          <span class:wt-today={day.today}>{day.label}</span>
        {/each}
      </div>
      <span>What's left</span>
    </div>
    {#each groups as group (group.project)}
      <section aria-label={`${group.project} tasks`}>
        <h2 class="wt-project">
          {group.project} <span>{group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}</span>
        </h2>
        {#each group.tasks as row (row.thread.threadId)}
          {@const situation = threadSituationCopy(row, dataset.generatedAt, dataset.sources)}
          {@const buckets = bucketThreadMarks(row.marks, timeZone)}
          <article
            class="wt-task-row"
            data-work-thread={row.thread.threadId}
            class:wt-waiting={row.thread.followState === 'waiting'}
          >
            <a
              class="wt-task-title"
              href={href(row.thread.threadId)}
              onclick={(event) => onOpen(event, row.thread.threadId)}
            >
              <strong>{row.thread.title}</strong>
              <span class="wt-meta">{threadRefs(row)}</span>
            </a>
            <fieldset aria-label={`This week's activity for ${row.thread.title}`} class="wt-week">
              {#each week as day}
                {@const marks = buckets.get(day.key) ?? []}
                {@const sessions = marks.filter((mark) => mark.kind === 'session')}
                <div class="wt-day" class:wt-today={day.today}>
                  {#if marks.length}
                    {@const singleGlyph = sessions.length === 1 ? harnessGlyph(sessions[0]?.harness ?? null) : ''}
                    {@const glyph = sessions.length > 1 ? `${sessions.length}` : singleGlyph}
                    {@const description = `${day.label}: ${sessions.length} sessions, ${marks.length - sessions.length} work events. ${marks.map((mark) => threadTime(mark.at, timeZone)).join(', ')}. Open for episode spans and context.`}
                    <a
                      aria-label={description}
                      class="wt-mark"
                      data-harness={sessions.length === 1 ? sessions[0]?.harness : ''}
                      href={href(row.thread.threadId, day.key)}
                      onclick={(event) => onOpen(event, row.thread.threadId, day.key)}
                      title={description}
                      class:wt-event-mark={!sessions.length}
                      class:wt-multi={sessions.length > 1}
                      >{glyph}</a
                    >
                  {/if}
                </div>
              {/each}
            </fieldset>
            <a
              aria-label={`What's left for ${row.thread.title}: ${situation.headline}`}
              class="wt-next"
              href={href(row.thread.threadId)}
              onclick={(event) => onOpen(event, row.thread.threadId)}
            >
              <span class="wt-hint" data-hint={situation.hint}><span aria-hidden="true">●</span>{situation.label}</span>
              <strong>{situation.headline}</strong><small>{situation.caption}</small>
            </a>
          </article>
        {/each}
      </section>
    {:else}
      <div class="wt-empty">
        <h2>{query.tab === 'done' ? 'No ended follow-ups here' : 'No tasks in this view'}</h2>
        <p>Try another project or search. Session intake remains available.</p>
        {#if query.project || query.search}
          <button class="wt-button" onclick={() => onFilter({ project: null, search: null })} type="button">
            Clear filters
          </button>
        {/if}
        <a class="wt-link" href="/work/sessions">Browse sessions</a>
      </div>
    {/each}
  </div>
  {#if dataset.nextCursor}
    <div class="wt-more">
      {#if continuation}
        <p class="wt-meta">{rows.length} tasks loaded. Continue in a new page; browser Back keeps this view.</p>
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
    <span><span class="wt-glyph" data-harness="claude">Cl</span> Claude session</span
    ><span><span class="wt-glyph" data-harness="codex">Cx</span> Codex session</span><span>○ Work event</span>
  </div>
  <span>Placed by day · open a mark for times and episode spans</span>
</div>
<p class="wt-quiet">
  “Done” means your follow-up has ended. A session ending, a PR merging and a ticket closing remain separate facts.
</p>
