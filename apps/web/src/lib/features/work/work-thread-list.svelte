<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type {
    WorkThreadListDataset,
    WorkThreadListQuery,
    WorkThreadRow,
  } from '@ai-usage/report-core/work-thread-view';
  import { tick } from 'svelte';
  import WorkThreadArtifacts from './work-thread-artifacts.svelte';
  import {
    bucketThreadMarks,
    groupThreadRows,
    harnessGlyph,
    harnessName,
    threadDate,
    threadSituationCopy,
    threadTime,
    threadWeek,
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
  let groupByProject = $state(false);
  const groups = $derived.by(() => {
    if (groupByProject) {
      return groupThreadRows(rows);
    }
    return rows.length ? [{ project: 'Latest activity', tasks: rows }] : [];
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

<div aria-labelledby={`work-tab-${query.tab}`} id="work-task-panel" role="tabpanel">
  <div class="wt-board">
    <div aria-hidden="true" class="wt-board-head">
      <span>Task · latest activity first ↓</span>
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
          {@const situation = threadSituationCopy(row, dataset.generatedAt, dataset.sources, timeZone)}
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
                  : ''}
              </p>
              <WorkThreadArtifacts now={dataset.generatedAt} {row} {timeZone} />
              <p class="wt-meta">
                Updated
                <time datetime={row.lastActivityAt}
                  >{threadDate(row.lastActivityAt, timeZone)}
                  · {threadTime(row.lastActivityAt, timeZone)}</time
                >
              </p>
            </div>
            <fieldset aria-label={`This week's activity for ${row.thread.title}`} class="wt-week">
              {#each week as day}
                {@const marks = buckets.get(day.key) ?? []}
                {@const sessions = marks.filter((mark) => mark.kind === 'session')}
                <div class="wt-day" class:wt-today={day.today}>
                  {#if marks.length}
                    {@const selected = selectedMarks?.threadId === row.thread.threadId && selectedMarks.day === day.key}
                    {@const description = `${day.label}: ${sessions.length} sessions, ${marks.length - sessions.length} work events. Show activity.`}
                    <button
                      aria-controls={selected ? `wt-marks-${row.thread.threadId}-${day.key}` : undefined}
                      aria-expanded={selected ? 'true' : 'false'}
                      aria-label={description}
                      class="wt-day-button"
                      id={`wt-mark-${row.thread.threadId}-${day.key}`}
                      onclick={() =>
                        (selectedMarks = selected ? null : { threadId: row.thread.threadId, day: day.key })}
                      onkeydown={(event) => {
                        if (event.key === 'Escape') {
                          closeMarks();
                        }
                      }}
                      title={description}
                      type="button"
                    >
                      {#if sessions.length}
                        <span
                          aria-hidden="true"
                          class="wt-mark"
                          data-harness={sessions.length === 1 ? sessions[0]?.harness : ''}
                          >{sessions.length > 1 ? sessions.length : harnessGlyph(sessions[0]?.harness ?? null)}</span
                        >
                      {/if}
                      {#if marks.length > sessions.length}
                        <span aria-hidden="true" class="wt-mark wt-event-mark"></span>
                      {/if}
                    </button>
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
  </div>
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
    <span><span class="wt-glyph" data-harness="claude">Cl</span> Claude session</span
    ><span><span class="wt-glyph" data-harness="codex">Cx</span> Codex session</span><span>○ Work event</span>
  </div>
  <span>Placed by day · open a mark for times and episode spans</span>
</div>
<p class="wt-quiet">
  “Done” means your follow-up has ended. A session ending, a PR merging and a ticket closing remain separate facts.
</p>
