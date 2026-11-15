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
  import WorkCombineSuggestions from './work-combine-suggestions.svelte';
  import WorkJiraIntake from './work-jira-intake.svelte';
  import WorkThreadCompactRow from './work-thread-compact-row.svelte';
  import {
    groupThreadRowsByBand,
    THREAD_BANDS,
    THREAD_LIFECYCLE_STEPS,
    THREAD_TIMELINE_MIN_DAYS,
    type ThreadBand,
    type ThreadLifecycleStep,
    threadBand,
    threadBandCounts,
    threadSituationCopy,
    threadWaitSince,
  } from './work-thread-model';
  import WorkThreadRail from './work-thread-rail.svelte';
  import WorkThreadSources from './work-thread-sources.svelte';
  import './work-thread-pilot.css';

  /** Ended follow-ups have their own list (the Done button), so they are not a band to filter on. */
  const CHIP_BANDS = THREAD_BANDS.filter((item) => item.band !== 'done');
  const DORMANT_ROWS_ID = 'wt-band-dormant-rows';
  const [legendStep] = THREAD_LIFECYCLE_STEPS;
  const LEGEND: readonly ThreadLifecycleStep[] = [
    { ...legendStep, state: 'done', name: 'Done', detail: 'the step is complete' },
    { ...legendStep, state: 'yours', name: 'Yours', detail: 'the step waits on you' },
    { ...legendStep, state: 'running', name: 'Running', detail: 'the step moves without you' },
    { ...legendStep, state: 'failed', name: 'Failing', detail: 'the step failed' },
    { ...legendStep, state: 'upcoming', name: 'To come', detail: 'the step has not started' },
    { ...legendStep, state: 'unread', name: 'Not read', detail: 'its source was not read' },
    { ...legendStep, state: 'none', name: 'Not applicable', detail: 'the task has no such step' },
  ];
  const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
  const tasksWord = (count: number): string => (count === 1 ? 'task' : 'tasks');

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
    band,
    onBand,
    focusId,
    loadingMore = false,
    moreUnavailable = false,
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
    band: ThreadBand | null;
    onBand: (band: ThreadBand | null) => void;
    /** The task the operator returns from, whose row takes focus back; `null` when there is none. */
    focusId: string | null;
    loadingMore?: boolean;
    moreUnavailable?: boolean;
    continuation?: boolean;
  } = $props();

  // One derivation per row and render: the situation, the band it lands in and when its wait began.
  const placed = $derived(
    new Map(
      rows.map((row) => {
        const situation = threadSituationCopy(row, dataset.generatedAt, dataset.sources, timeZone);
        return [
          row.thread.threadId,
          {
            situation,
            band: threadBand(row, situation, dataset.generatedAt),
            since: threadWaitSince(row, situation).at,
          },
        ];
      }),
    ),
  );
  const placeOf = (row: WorkThreadRow) => {
    const place = placed.get(row.thread.threadId);
    if (!place) {
      throw new Error(`Task ${row.thread.threadId} was not placed in a band.`);
    }
    return place;
  };
  const groups = $derived(
    groupThreadRowsByBand(
      rows,
      (row) => placeOf(row).band,
      (row) => placeOf(row).since,
    ),
  );
  const counts = $derived(threadBandCounts(rows, (row) => placeOf(row).band));
  const visible = $derived(band === null ? groups : groups.filter((group) => group.band === band));

  // The counters cover the loaded rows; under a filter the total of followed tasks is not the total of matches.
  const partialNote = $derived(
    query.project || query.search
      ? `first ${rows.length} matching tasks counted`
      : `first ${rows.length} of ${dataset.counts.open} tasks counted`,
  );

  // A filter on the dormant band, a search or the return from a dormant task (its row takes focus
  // back, so it has to be rendered) opens the fold; a toggle holds for the view it was made in.
  const dormantWanted = $derived(
    band === 'dormant' || Boolean(query.search) || (focusId !== null && placed.get(focusId)?.band === 'dormant'),
  );
  let dormantToggle = $state<{ wanted: boolean; open: boolean } | null>(null);
  const dormantOpen = $derived(
    dormantToggle !== null && dormantToggle.wanted === dormantWanted ? dormantToggle.open : dormantWanted,
  );
</script>

<div class="wt-pilot-bar">
  <div class="wt-pilot-bands">
    <fieldset aria-label="Filter tasks by whose move it is" class="wt-band-chips">
      {#if query.tab === 'done'}
        <button
          aria-pressed="false"
          class="wt-band-chip"
          data-tab="open"
          onclick={() => onFilter({ tab: 'open' })}
          type="button"
        >
          Following <strong>{dataset.counts.open}</strong>
        </button>
        <button
          aria-pressed="true"
          class="wt-band-chip"
          data-tab="done"
          onclick={() => onFilter({ tab: 'open' })}
          type="button"
        >
          Done <strong>{dataset.counts.done}</strong>
        </button>
      {:else}
        {#each CHIP_BANDS as item (item.band)}
          <button
            aria-pressed={band === item.band ? 'true' : 'false'}
            class="wt-band-chip"
            data-band={item.band}
            onclick={() => onBand(band === item.band ? null : item.band)}
            type="button"
          >
            <svg aria-hidden="true" class="wt-band-dot" height="8" viewBox="0 0 8 8" width="8">
              <circle cx="4" cy="4" fill="currentColor" r="3.5" />
            </svg>
            <strong>{counts[item.band]}</strong>
            {item.label.toLowerCase()}
          </button>
        {/each}
        <button
          aria-pressed="false"
          class="wt-band-chip"
          data-tab="done"
          onclick={() => onFilter({ tab: 'done' })}
          type="button"
        >
          Done <strong>{dataset.counts.done}</strong>
        </button>
      {/if}
    </fieldset>
    {#if query.tab === 'open' && dataset.nextCursor}
      <p class="wt-pilot-partial">{partialNote}</p>
    {/if}
  </div>
  <div class="wt-filters">
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

{#snippet taskRows(
  tasks: readonly WorkThreadRow[],
)}
  {#each tasks as row (row.thread.threadId)}
    {@const place = placeOf(row)}
    <WorkThreadCompactRow
      band={place.band}
      href={href(row.thread.threadId)}
      now={dataset.generatedAt}
      onOpen={(event) => onOpen(event, row.thread.threadId)}
      {row}
      situation={place.situation}
      {timeZone}
    />
  {/each}
{/snippet}

<div class="wt-pilot-board">
  {#if visible.length > 0}
    <div aria-hidden="true" class="wt-pilot-cols wt-pilot-colhead">
      <span>Project</span>
      <span>Task</span>
      <span class="wt-pilot-steps">
        {#each THREAD_LIFECYCLE_STEPS as step (step.key)}
          <span>{step.short}</span>
        {/each}
      </span>
      <span class="wt-col-activity">{THREAD_TIMELINE_MIN_DAYS} days</span>
      <span>Next</span>
      <span class="wt-col-age">Age</span>
    </div>
  {/if}
  {#each visible as group (group.band)}
    {@const headingId = `wt-band-${group.band}`}
    <section aria-labelledby={headingId} class="wt-band" data-band={group.band}>
      {#if group.band === 'dormant'}
        {@const yours = group.tasks.filter((row) => placeOf(row).situation.hint === 'to-resume').length}
        <h2 class="wt-band-head" id={headingId}>
          <button
            aria-controls={DORMANT_ROWS_ID}
            aria-expanded={dormantOpen ? 'true' : 'false'}
            class="wt-band-fold"
            onclick={() => (dormantToggle = { wanted: dormantWanted, open: !dormantOpen })}
            type="button"
          >
            <span
              ><strong>{group.tasks.length} {group.label.toLowerCase()} {tasksWord(group.tasks.length)}</strong>
              · {lowerFirst(group.note)}{yours > 0 ? ` · ${yours} with a step of yours` : ''}</span
            >
            <span class="wt-band-fold-action">{dormantOpen ? 'Hide' : 'Show'}</span>
          </button>
        </h2>
        <ul class="wt-pilot-rows" hidden={!dormantOpen} id={DORMANT_ROWS_ID}>
          {#if dormantOpen}
            {@render taskRows(group.tasks)}
          {/if}
        </ul>
      {:else}
        <h2 class="wt-band-head" id={headingId}>
          <strong>{group.label}</strong>
          <span class="wt-band-count"
            >{group.tasks.length}<span class="wt-sr">{` ${tasksWord(group.tasks.length)}`}</span></span
          >
          <span>· {lowerFirst(group.note)}</span>
        </h2>
        <ul class="wt-pilot-rows">
          {@render taskRows(group.tasks)}
        </ul>
      {/if}
    </section>
  {:else}
    {#if band !== null && groups.length > 0}
      <div class="wt-empty">
        <h2>No tasks in this band</h2>
        <button class="wt-button" onclick={() => onBand(null)} type="button">Show all bands</button>
      </div>
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
    {/if}
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
    <button class="wt-button" disabled={loadingMore || moreUnavailable} onclick={onMore} type="button">
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
<p class="wt-sr" role="status">{rows.length} tasks loaded.</p>
<ul aria-label="Lifecycle step states" class="wt-pilot-legend">
  {#each LEGEND as step (step.state)}
    <li>
      <span aria-hidden="true"><WorkThreadRail steps={[step]} /></span>{step.name}
    </li>
  {/each}
</ul>
<p class="wt-quiet">
  “Done” means your follow-up has ended. A session ending, a PR merging and a ticket closing remain separate facts.
</p>
