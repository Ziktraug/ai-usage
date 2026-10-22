<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed boolean ARIA values for the pressed filter chips -->
<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { searchInput } from '@ai-usage/design-system/svelte';
  import type { WorkAttentionDataset, WorkAttentionKind } from '@ai-usage/report-core/work-attention';
  import { onMount, tick, untrack } from 'svelte';
  import {
    filterWorkRoots,
    groupWorkRoots,
    hasWorkAttentionFilters,
    nextWorkRowIndex,
    toggleListValue,
    type WorkAttentionSearch,
    workAttentionSectionFor,
    workFilterOptions,
    workHarnessLabel,
    workRootId,
    workSearchCoverage,
  } from './work-attention-model';
  import WorkAttentionRow from './work-attention-row.svelte';
  import {
    workChipButton,
    workChipCount,
    workFilterBar,
    workFilterGroup,
    workFilterLabel,
    workMuted,
    workRowList,
    workSearchField,
    workSection,
    workSectionCount,
    workSectionHeader,
    workSectionNote,
    workSectionTitle,
    workShowMore,
    workStack,
    workSubsectionTitle,
  } from './work-styles';

  let {
    dataset,
    search,
    selectedId,
    onSearch,
    onSelect,
    onFocusRow,
  }: {
    dataset: WorkAttentionDataset;
    search: WorkAttentionSearch;
    selectedId: string | null;
    onSearch: (patch: Partial<WorkAttentionSearch>) => void;
    onSelect: (id: string) => void;
    onFocusRow: (id: string) => void;
  } = $props();

  const QUERY_DEBOUNCE_MS = 150;
  let host = $state<HTMLElement>();
  let queryDraft = $state(untrack(() => search.query));
  let lastSubmittedQuery = untrack(() => search.query);
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  let expandedSections = $state<ReadonlySet<WorkAttentionKind>>(new Set());
  let focusedId = $state<string | null>(null);
  const options = $derived(workFilterOptions(dataset.roots));
  const visible = $derived(filterWorkRoots(dataset.roots, search));
  const groups = $derived(groupWorkRoots(visible));
  const visibleIds = $derived(groups.flatMap((group) => group.roots.map(workRootId)));
  // The one row in the tab sequence: the focused row, else the selected row, else the first one.
  const activeId = $derived(
    [focusedId, selectedId, visibleIds[0] ?? null].find((id) => id !== null && visibleIds.includes(id)) ?? null,
  );
  const filtered = $derived(hasWorkAttentionFilters(search));
  // The address is the source of truth for the query, except while our own debounced write is in
  // flight: an external change (history traversal, a shared link) replaces the draft, our own echo
  // never clobbers characters typed after it was submitted.
  const syncDraft = (value: string): void => {
    if (value !== lastSubmittedQuery) {
      lastSubmittedQuery = value;
      queryDraft = value;
    }
  };
  $effect(() => syncDraft(search.query));
  const rowsShown = (kind: WorkAttentionKind, count: number): number => {
    const limit = workAttentionSectionFor(kind).collapseBeyond;
    if (limit === null || expandedSections.has(kind) || count <= limit) {
      return count;
    }
    const selectedIndex = groups
      .find((group) => group.section.kind === kind)
      ?.roots.findIndex((root) => workRootId(root) === selectedId);
    // A selected row stays reachable even when its section is folded.
    return selectedIndex !== undefined && selectedIndex >= limit ? count : limit;
  };
  const expand = (kind: WorkAttentionKind): void => {
    expandedSections = new Set([...expandedSections, kind]);
  };
  const submitQuery = (value: string): void => {
    queryDraft = value;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      lastSubmittedQuery = value.trim();
      onSearch({ query: value });
    }, QUERY_DEBOUNCE_MS);
  };
  const rowButton = (id: string): HTMLButtonElement | null =>
    host?.querySelector<HTMLButtonElement>(`[data-work-root="${CSS.escape(id)}"]`) ?? null;
  /** Moves focus to one row, folding nothing: returns false when the row is not rendered. */
  export const focusRoot = async (id: string): Promise<boolean> => {
    await tick();
    const button = rowButton(id);
    if (!button) {
      return false;
    }
    focusedId = id;
    button.focus({ preventScroll: false });
    return document.activeElement === button;
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)) {
      return;
    }
    const current = event.target.closest<HTMLElement>('[data-work-root]')?.dataset.workRoot;
    if (current === undefined) {
      return;
    }
    const index = visibleIds.indexOf(current);
    const next = nextWorkRowIndex(index, event.key, visibleIds.length);
    if (next === null) {
      return;
    }
    const target = visibleIds[next];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    focusRoot(target);
  };
  const focusin = (event: FocusEvent): void => {
    const id =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-work-root]')?.dataset.workRoot
        : undefined;
    if (id !== undefined) {
      focusedId = id;
      onFocusRow(id);
    }
  };
  const attentionLabel = (kind: WorkAttentionKind): string => workAttentionSectionFor(kind).title;
  // Row movement is delegated from the sections container, which stays a plain landmark-free
  // wrapper: the rows themselves are the interactive elements, so the handlers are installed here.
  onMount(() => {
    const element = host;
    if (!element) {
      return;
    }
    element.addEventListener('keydown', keydown);
    element.addEventListener('focusin', focusin);
    return () => {
      clearTimeout(queryTimer);
      element.removeEventListener('keydown', keydown);
      element.removeEventListener('focusin', focusin);
    };
  });
</script>

<div class={workStack} data-work-board>
  <search class={workFilterBar}>
    <label class={workMuted} for="work-search">Search title, project, question, branch or PR</label>
    <input
      autocomplete="off"
      class={cx(searchInput, workSearchField)}
      id="work-search"
      oninput={(event) => submitQuery(event.currentTarget.value)}
      placeholder="Search roots"
      type="search"
      value={queryDraft}
    >
  </search>
  <div class={workFilterBar} data-work-filters>
    <span class={workFilterGroup}>
      <span class={workFilterLabel}>Attention</span>
      {#each options.attention as option (option.value)}
        <button
          aria-pressed={search.attention.includes(option.value as WorkAttentionKind)}
          class={workChipButton}
          onclick={() => onSearch({ attention: toggleListValue(search.attention, option.value) as WorkAttentionKind[] })}
          type="button"
        >
          {attentionLabel(option.value as WorkAttentionKind)}
          <span class={workChipCount}>{option.count}</span>
        </button>
      {/each}
    </span>
    <span class={workFilterGroup}>
      <span class={workFilterLabel}>Harness</span>
      {#each options.harness as option (option.value)}
        <button
          aria-pressed={search.harness.includes(option.value)}
          class={workChipButton}
          onclick={() => onSearch({ harness: toggleListValue(search.harness, option.value) })}
          type="button"
        >
          {workHarnessLabel(option.value)}
          <span class={workChipCount}>{option.count}</span>
        </button>
      {/each}
    </span>
    {#if options.machine.length > 1}
      <span class={workFilterGroup}>
        <span class={workFilterLabel}>Machine</span>
        {#each options.machine as option (option.value)}
          <button
            aria-pressed={search.machine.includes(option.value)}
            class={workChipButton}
            onclick={() => onSearch({ machine: toggleListValue(search.machine, option.value) })}
            type="button"
          >
            {option.value}
            <span class={workChipCount}>{option.count}</span>
          </button>
        {/each}
      </span>
    {/if}
    {#if options.project.length > 1}
      <span class={workFilterGroup}>
        <span class={workFilterLabel}>Project</span>
        {#each options.project as option (option.value)}
          <button
            aria-pressed={search.project.includes(option.value)}
            class={workChipButton}
            onclick={() => onSearch({ project: toggleListValue(search.project, option.value) })}
            type="button"
          >
            {option.value}
            <span class={workChipCount}>{option.count}</span>
          </button>
        {/each}
      </span>
    {/if}
    {#if filtered}
      <button
        class={workChipButton}
        onclick={() => onSearch({ attention: [], harness: [], machine: [], project: [], query: '' })}
        type="button"
      >
        Clear filters
      </button>
    {/if}
  </div>
  <p aria-live="polite" class={workMuted} data-work-search-coverage role="status">
    {workSearchCoverage(dataset, visible.length, filtered)}
  </p>
  <div class={workStack} data-work-sections bind:this={host}>
    {#each groups as group (group.section.kind)}
      {#if group.roots.length > 0}
        {@const shown = rowsShown(group.section.kind, group.roots.length)}
        {@const rows = group.roots.slice(0, shown)}
        {@const current = group.section.kind === 'human-request' ? rows.filter((root) => !root.reconsidered) : rows}
        {@const toReconsider = group.section.kind === 'human-request' ? rows.filter((root) => root.reconsidered) : []}
        <section
          aria-labelledby={`work-section-${group.section.kind}`}
          class={workSection}
          data-work-section={group.section.kind}
        >
          <header class={workSectionHeader}>
            <h2 class={workSectionTitle} id={`work-section-${group.section.kind}`}>{group.section.title}</h2>
            <span class={workSectionCount}>{group.roots.length}</span>
            <p class={workSectionNote}>
              {group.section.note}
              {#if group.section.kind !== 'none' && group.section.kind !== 'not-observable'}
                {#if group.roots.some((root) => root.key.harness === 'codex' && root.attention === 'human-request')}
                  Native request evidence and session declarations; general state unobserved.
                {:else}
                  Declared by the session; current state unobserved.
                {/if}
              {/if}
            </p>
          </header>
          {#if current.length > 0}
            <ul class={workRowList}>
              {#each current as root (workRootId(root))}
                <WorkAttentionRow
                  {onSelect}
                  reference={dataset.generatedAt}
                  {root}
                  selected={workRootId(root) === selectedId}
                  tabindex={workRootId(root) === activeId ? 0 : -1}
                />
              {/each}
            </ul>
          {/if}
          {#if toReconsider.length > 0}
            <h3 class={workSubsectionTitle} data-work-reconsider-heading id="work-section-reconsider">
              Older declarations to reconsider · {toReconsider.length}
            </h3>
            <ul aria-labelledby="work-section-reconsider" class={workRowList} data-work-reconsider>
              {#each toReconsider as root (workRootId(root))}
                <WorkAttentionRow
                  {onSelect}
                  reference={dataset.generatedAt}
                  {root}
                  selected={workRootId(root) === selectedId}
                  tabindex={workRootId(root) === activeId ? 0 : -1}
                />
              {/each}
            </ul>
          {/if}
          {#if shown < group.roots.length}
            <button class={workShowMore} onclick={() => expand(group.section.kind)} type="button">
              Show all {group.roots.length} in {group.section.title}
            </button>
          {/if}
        </section>
      {/if}
    {/each}
    {#if visible.length === 0}
      <p class={workMuted} role="status">
        {filtered
          ? 'No root in this ranking matches these filters; what was not searched is listed above.'
          : 'No declared outcomes collected yet. Collection coverage is listed above; absence is not completion.'}
      </p>
    {/if}
  </div>
</div>
