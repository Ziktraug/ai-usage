<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/useValidAriaValues: virtualized rows preserve the legacy keyboard surface; Svelte emits the closed dynamic WAI-ARIA values asserted by SSR tests -->
<script lang="ts">
  import { Checkbox, HarnessBadge, Popover } from '@ai-usage/design-system/svelte';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { ExpandedState } from '@tanstack/table-core';
  import { onMount, untrack } from 'svelte';
  import { calculateSessionViewportHeight } from '../../../../session-row-window';
  import {
    browserSessionSurfaceModeEnvironment,
    createSessionSurfaceModeController,
    type SessionSurfaceMode,
  } from '../../../../session-surface-mode';
  import {
    columnVisibilityForSessionPreset,
    defaultColumnVisibility,
    isSessionColumnVisible,
    type SessionColumnId,
    sessionColumnPresetForVisibility,
    sessionColumnPresets,
  } from '../../../../session-table-schema';
  import { fmtDate } from '../../../foundation/presentation/format';
  import type { StateChangeHandler, TableSortingState, TableVisibilityState } from '../../../foundation/table/state';
  import SessionCell from './session-cell.svelte';
  import {
    projectSessionCell,
    sessionSortDescendingByDefault,
    sessionSortForColumnChange,
    shouldSelectSessionRowForKey,
  } from './session-cell-projection';
  import { sessionTableColumns, visibleSessionTableColumns } from './session-columns';
  import { createSessionTableModel, toggleSessionRowExpanded } from './session-table-model';
  import type { SessionCampaignPage } from './session-table-query-owner';
  import {
    controlButton,
    controls,
    empty,
    highlightedMark,
    mobileCard,
    mobileHeader,
    mobileList,
    mobileMeta,
    mobileOpen,
    mobileRow,
    mobileSort,
    numeric,
    paging,
    popoverGrid,
    presetGroup,
    select,
    sessionCell,
    sortButton,
    surface,
    table,
  } from './session-table-styles';
  import {
    isSessionPagePrefetchRequired,
    projectSessionVirtualRows,
    sessionVirtualBudgets,
  } from './session-virtualization';

  const SESSION_VIEWPORT_BOTTOM_INSET = 24;
  const SESSION_VIEWPORT_FALLBACK_HEIGHT = 520;
  const MIN_SESSION_TABLE_WIDTH = 720;
  const DESKTOP_MINIMUM_VIEWPORT_HEIGHT = sessionVirtualBudgets.desktop.rowHeight * 3;
  const MOBILE_MINIMUM_VIEWPORT_HEIGHT = sessionVirtualBudgets.mobile.rowHeight;

  interface Props {
    campaignChildren?: ReadonlyMap<string, SessionCampaignPage>;
    columnVisibility: TableVisibilityState;
    hasMoreRows?: boolean;
    initialExpanded?: ExpandedState;
    initialSurfaceMode?: Exclude<SessionSurfaceMode, 'pending'>;
    loading?: boolean;
    loadingMoreRows?: boolean;
    onClearFilters: () => void;
    onColumnVisibilityChange: StateChangeHandler<TableVisibilityState>;
    onFieldFilter: (key: 'campaign' | 'model' | 'project' | 'provider', value: string) => void;
    onHarnessFilter: (value: string) => void;
    onLoadCampaignChildren?: (campaignKey: string) => void;
    onLoadMoreRows?: () => void;
    onSelect: (row: SessionPresentationRow) => void;
    onSortingChange: StateChangeHandler<TableSortingState>;
    queryResetKey: string;
    rows: readonly SessionPresentationRow[];
    searchQuery?: string;
    selectedRowId: string | null;
    sorting: TableSortingState;
    totalRows?: number;
  }

  let {
    campaignChildren = new Map(),
    columnVisibility,
    hasMoreRows = false,
    initialExpanded = {},
    loading = false,
    loadingMoreRows = false,
    onClearFilters,
    onColumnVisibilityChange,
    onFieldFilter,
    onHarnessFilter,
    onLoadCampaignChildren,
    onLoadMoreRows,
    onSelect,
    onSortingChange,
    queryResetKey,
    rows,
    searchQuery = '',
    selectedRowId,
    sorting,
    initialSurfaceMode = 'desktop',
    totalRows,
  }: Props = $props();

  let expanded = $state<ExpandedState>(untrack(() => initialExpanded));
  let mode = $state<SessionSurfaceMode>(untrack(() => initialSurfaceMode));
  let scrollTop = $state(0);
  let viewportHeight = $state(520);
  let surfaceElement = $state<HTMLElement>();
  let sessionRegionStartElement = $state<HTMLElement>();
  let anchoredSurfaceElement = $state<HTMLElement>();
  let previousResetKey = $state('');
  let pagingSignature = $state('');
  let pendingFocusIndex = $state<number>();

  const effectiveVisibility = $derived(
    rows.some((row) => Boolean(row.rtkSavedTokens)) ? columnVisibility : { ...columnVisibility, rtkSaved: false },
  );
  const model = $derived(
    createSessionTableModel({
      canLoadCampaignChildren: Boolean(onLoadCampaignChildren),
      expanded,
      rows,
      sorting,
      visibility: effectiveVisibility,
    }),
  );
  const visibleColumns = $derived(visibleSessionTableColumns(effectiveVisibility));
  const activeMode = $derived(mode === 'mobile' ? 'mobile' : 'desktop');
  const virtual = $derived(
    projectSessionVirtualRows({ mode: activeMode, rows: model.rows, scrollTop, viewportHeight }),
  );
  const activeSort = $derived(sorting[0] ?? { desc: true, id: 'date' });
  const activePreset = $derived(sessionColumnPresetForVisibility(columnVisibility));
  const visibleColumnWidthTotal = $derived(visibleColumns.reduce((total, entry) => total + entry.meta.widthPx, 0));
  const tableMinWidth = $derived(
    activePreset ? MIN_SESSION_TABLE_WIDTH : Math.max(MIN_SESSION_TABLE_WIDTH, visibleColumnWidthTotal),
  );
  const columnWidth = (width: number): string =>
    activePreset ? `${(width / visibleColumnWidthTotal) * 100}%` : `${width}px`;

  const ariaSortFor = (id: SessionColumnId): 'ascending' | 'descending' | 'none' => {
    if (activeSort.id !== id) {
      return 'none';
    }
    return activeSort.desc ? 'descending' : 'ascending';
  };

  const updateViewportFor = (element: HTMLElement, surfaceMode: 'desktop' | 'mobile'): void => {
    if (surfaceElement !== element || activeMode !== surfaceMode) {
      return;
    }
    const minimumHeight = surfaceMode === 'desktop' ? DESKTOP_MINIMUM_VIEWPORT_HEIGHT : MOBILE_MINIMUM_VIEWPORT_HEIGHT;
    const nextHeight = calculateSessionViewportHeight({
      bottomInset: SESSION_VIEWPORT_BOTTOM_INSET,
      minimumHeight,
      surfaceTop: element.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    });
    const cssHeight = `${nextHeight}px`;
    if (element.style.getPropertyValue('--session-surface-height') !== cssHeight) {
      element.style.setProperty('--session-surface-height', cssHeight);
    }
    scrollTop = element.scrollTop;
    viewportHeight = element.clientHeight || SESSION_VIEWPORT_FALLBACK_HEIGHT;
  };

  const updateViewport = (): void => {
    if (surfaceElement) {
      updateViewportFor(surfaceElement, activeMode);
    }
  };

  const setSurfaceElement = (element: HTMLElement): void => {
    surfaceElement = element;
    updateViewport();
  };

  onMount(() => {
    const controller = createSessionSurfaceModeController(browserSessionSurfaceModeEnvironment());
    return controller.start((nextMode) => {
      mode = nextMode;
      scrollTop = 0;
      surfaceElement?.scrollTo({ top: 0 });
      updateViewport();
    });
  });

  $effect(() => {
    const activeSurface = surfaceElement;
    const observedMode = activeMode;
    if (!activeSurface) {
      return;
    }
    const synchronize = (): void => updateViewportFor(activeSurface, observedMode);
    synchronize();
    const observer = new ResizeObserver(synchronize);
    observer.observe(activeSurface);
    window.addEventListener('resize', synchronize);
    window.addEventListener('scroll', synchronize, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', synchronize);
      window.removeEventListener('scroll', synchronize);
    };
  });

  $effect(() => {
    const activeSurface = surfaceElement;
    const regionStart = sessionRegionStartElement;
    if (anchoredSurfaceElement === activeSurface || !activeSurface || !regionStart) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      anchoredSurfaceElement = activeSurface;
      activeSurface.style.removeProperty('--session-surface-height');
      regionStart.scrollIntoView({ block: 'start' });
      updateViewportFor(activeSurface, activeMode);
    });
    return () => window.cancelAnimationFrame(frame);
  });

  $effect(() => {
    if (queryResetKey !== previousResetKey) {
      previousResetKey = queryResetKey;
      pagingSignature = '';
      expanded = {};
      scrollTop = 0;
      surfaceElement?.scrollTo({ top: 0 });
    }
  });

  $effect(() => {
    const required = isSessionPagePrefetchRequired({
      endIndex: virtual.endIndex,
      hasMore: hasMoreRows,
      loading: loadingMoreRows,
      mode: activeMode,
      rowCount: model.rows.length,
    });
    const signature = `${queryResetKey}:${activeMode}:${model.rows.length}:${virtual.endIndex}`;
    if (required && signature !== pagingSignature) {
      pagingSignature = signature;
      onLoadMoreRows?.();
    }
  });

  const changeSort = (id: SessionColumnId): void => {
    const current = sorting[0];
    const desc = current?.id === id ? !current.desc : sessionSortDescendingByDefault(id);
    onSortingChange([{ desc, id }]);
  };
  const changeSortColumn = (id: SessionColumnId): void => {
    onSortingChange(sessionSortForColumnChange(sorting, id));
  };

  const setColumnVisible = (id: SessionColumnId, visible: boolean): void => {
    onColumnVisibilityChange((current) => ({ ...current, [id]: visible }));
  };

  const toggleExpanded = (row: SessionPresentationRow): void => {
    const wasExpanded = typeof expanded === 'object' && Boolean(expanded[row.rowId]);
    expanded = toggleSessionRowExpanded(expanded, row.rowId);
    if (!wasExpanded && row.campaignKey && !row.children?.length) {
      onLoadCampaignChildren?.(row.campaignKey);
    }
  };

  const onRowKeydown = (event: KeyboardEvent, row: SessionPresentationRow, index: number, activate = true): void => {
    if (shouldSelectSessionRowForKey(event.key, !activate)) {
      event.preventDefault();
      onSelect(row);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const targetIndex = Math.max(0, Math.min(model.rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const target = surfaceElement?.querySelector<HTMLElement>(`[data-session-index="${targetIndex}"]`);
    if (target) {
      pendingFocusIndex = undefined;
      target.focus();
      return;
    }
    pendingFocusIndex = targetIndex;
    surfaceElement?.scrollTo({ top: targetIndex * (activeMode === 'desktop' ? 43 : 188) });
  };

  $effect(() => {
    if (
      pendingFocusIndex === undefined ||
      typeof window === 'undefined' ||
      pendingFocusIndex < virtual.startIndex ||
      pendingFocusIndex >= virtual.endIndex
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = surfaceElement?.querySelector<HTMLElement>(`[data-session-index="${pendingFocusIndex}"]`);
      if (target) {
        pendingFocusIndex = undefined;
        target.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  });
</script>

{#if rows.length === 0}
  <div class={empty} data-session-empty>
    {#if loading}
      <span aria-live="polite">Loading sessions…</span>
    {:else}
      <span>No sessions match the current filters</span>
      <button class={controlButton} onclick={onClearFilters} type="button">Clear filters</button>
    {/if}
  </div>
{:else}
  <section aria-label="Sessions" data-session-mode={activeMode} data-session-table-owner>
    <div class={controls} data-session-region-start bind:this={sessionRegionStartElement}>
      {#if activeMode === 'desktop'}
        <fieldset aria-label="Session column presets" class={presetGroup}>
          {#each sessionColumnPresets as preset (preset.id)}
            <button
              aria-pressed={activePreset === preset.id}
              class={controlButton}
              data-default={preset.id === 'work'}
              onclick={() => onColumnVisibilityChange(columnVisibilityForSessionPreset(preset.id))}
              type="button"
            >
              {preset.label}
            </button>
          {/each}
          <Popover triggerClass={controlButton}>
            {#snippet trigger()}
              Advanced columns · {visibleColumns.length} ▾
            {/snippet}
            <div class={popoverGrid}>
              {#each sessionTableColumns.filter((entry) => entry.id !== 'session') as entry (entry.id)}
                <Checkbox
                  checked={isSessionColumnVisible(columnVisibility, entry.id)}
                  onCheckedChange={(checked) => setColumnVisible(entry.id, checked)}
                >
                  {entry.meta.label}
                </Checkbox>
              {/each}
              <button
                class={controlButton}
                onclick={() => onColumnVisibilityChange(defaultColumnVisibility)}
                type="button"
              >
                Reset
              </button>
            </div>
          </Popover>
        </fieldset>
      {:else}
        <div class={mobileSort}>
          <label>
            <span>Sort by </span>
            <select
              aria-label="Sort mobile session summaries"
              class={select}
              onchange={(event) => changeSortColumn(event.currentTarget.value as SessionColumnId)}
              value={activeSort.id}
            >
              {#each sessionTableColumns as entry (entry.id)}
                <option value={entry.id}>{entry.meta.label}</option>
              {/each}
            </select>
          </label>
          <button class={controlButton} onclick={() => changeSort(activeSort.id as SessionColumnId)} type="button">
            {activeSort.desc ? 'Descending ↓' : 'Ascending ↑'}
          </button>
        </div>
      {/if}
      <span aria-live="polite">{totalRows ?? rows.length} sessions</span>
    </div>

    {#if activeMode === 'desktop'}
      <div
        class={surface}
        data-session-surface="desktop"
        onscroll={updateViewport}
        bind:this={surfaceElement}
        use:setSurfaceElement
      >
        <table aria-rowcount={totalRows ?? model.rows.length} class={table} style:min-width={`${tableMinWidth}px`}>
          <thead>
            <tr>
              {#each visibleColumns as entry (entry.id)}
                <th
                  aria-sort={ariaSortFor(entry.id)}
                  class={entry.meta.align === 'right' ? numeric : undefined}
                  scope="col"
                  title={entry.meta.title}
                  style:width={columnWidth(entry.meta.widthPx)}
                >
                  <button class={sortButton} onclick={() => changeSort(entry.id)} type="button">
                    <span>{typeof entry.header === 'string' ? entry.header : entry.meta.label}</span>
                    {#if activeSort.id === entry.id}
                      <span aria-hidden="true">{activeSort.desc ? '↓' : '↑'}</span>
                    {/if}
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#if virtual.topHeight > 0}
              <tr aria-hidden="true" data-virtual-spacer="top">
                <td colspan={visibleColumns.length} style:height={`${virtual.topHeight}px`}></td>
              </tr>
            {/if}
            {#each virtual.rows as virtualRow (virtualRow.row.id)}
              <tr
                data-depth={virtualRow.row.depth}
                data-index={virtualRow.index}
                data-selected={selectedRowId === virtualRow.row.id}
                data-session-index={virtualRow.index}
                data-session-row-id={virtualRow.row.id}
                onclick={() => onSelect(virtualRow.row.original)}
                onkeydown={(event) => onRowKeydown(event, virtualRow.row.original, virtualRow.index)}
                tabindex="0"
              >
                {#each visibleColumns as entry (entry.id)}
                  <td
                    class={[entry.meta.align === 'right' ? numeric : undefined, entry.id === 'session' ? sessionCell : undefined]}
                  >
                    <SessionCell
                      canExpand={virtualRow.row.getCanExpand()}
                      columnId={entry.id}
                      depth={virtualRow.row.depth}
                      expanded={virtualRow.row.getIsExpanded()}
                      {onFieldFilter}
                      {onHarnessFilter}
                      onToggleExpanded={() => toggleExpanded(virtualRow.row.original)}
                      query={searchQuery}
                      row={virtualRow.row.original}
                    />
                  </td>
                {/each}
              </tr>
            {/each}
            {#if virtual.bottomHeight > 0}
              <tr aria-hidden="true" data-virtual-spacer="bottom">
                <td colspan={visibleColumns.length} style:height={`${virtual.bottomHeight}px`}></td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {:else}
      <ul
        aria-label="Session summaries"
        class={[surface, mobileList]}
        data-session-list-gap="0"
        data-session-list-padding="0"
        data-session-surface="mobile"
        onscroll={updateViewport}
        bind:this={surfaceElement}
        use:setSurfaceElement
      >
        {#if virtual.topHeight > 0}
          <li aria-hidden="true" data-virtual-spacer="top" style:height={`${virtual.topHeight}px`}></li>
        {/if}
        {#each virtual.rows as virtualRow (virtualRow.row.id)}
          {@const mobileSession = projectSessionCell(virtualRow.row.original, 'session', searchQuery)}
          {@const mobileValue = projectSessionCell(virtualRow.row.original, 'cost', searchQuery)}
          {@const mobileFresh = projectSessionCell(virtualRow.row.original, 'fresh', searchQuery)}
          {@const mobileCache = projectSessionCell(virtualRow.row.original, 'cache', searchQuery)}
          {@const mobileDuration = projectSessionCell(virtualRow.row.original, 'duration', searchQuery)}
          <li
            aria-posinset={virtualRow.index + 1}
            aria-setsize={Math.max(totalRows ?? 0, model.rows.length)}
            class={mobileRow}
            data-depth={virtualRow.row.depth}
            data-index={virtualRow.index}
            data-session-row-height="188"
            data-session-row-id={virtualRow.row.id}
          >
            <article
              class={mobileCard}
              data-depth={virtualRow.row.depth}
              data-selected={selectedRowId === virtualRow.row.id}
              data-session-card-height="180"
            >
              <header class={mobileHeader}>
                <span>{fmtDate(virtualRow.row.original.activeDate)}</span>
                <HarnessBadge
                  name={virtualRow.row.original.harness}
                  onClick={() => onHarnessFilter(virtualRow.row.original.harness)}
                />
              </header>
              <button
                aria-label={mobileSession.kind === 'session'
                  ? `Inspect session: ${mobileSession.segments.map(({ text }) => text).join('')}`
                  : undefined}
                class={mobileOpen}
                data-session-index={virtualRow.index}
                onclick={() => onSelect(virtualRow.row.original)}
                onkeydown={(event) => onRowKeydown(event, virtualRow.row.original, virtualRow.index, false)}
                tabindex="0"
                type="button"
              >
                <span>
                  {#if mobileSession.kind === 'session'}
                    {#each mobileSession.segments as segment, index (`mobile:${index}:${segment.text}`)}
                      {#if segment.match}
                        <mark class={highlightedMark}>{segment.text}</mark>
                      {:else}
                        {segment.text}
                      {/if}
                    {/each}
                  {/if}
                </span>
                {#if mobileValue.kind === 'value'}
                  <span title={mobileValue.title}>{mobileValue.label}</span>
                {/if}
              </button>
              <div>
                <button
                  class={controlButton}
                  onclick={() => onFieldFilter('project', virtualRow.row.original.projectKey)}
                  title={`Filter by project ${virtualRow.row.original.projectLabel}`}
                  type="button"
                >
                  {virtualRow.row.original.projectLabel === '(unknown)' ? 'No project' : virtualRow.row.original.projectLabel}
                </button>
                <button
                  class={controlButton}
                  onclick={() => onFieldFilter('model', virtualRow.row.original.modelKey)}
                  title={`Filter by model ${virtualRow.row.original.modelKey}`}
                  type="button"
                >
                  {virtualRow.row.original.modelLabel}
                </button>
                {#if virtualRow.row.getCanExpand()}
                  <button
                    class={controlButton}
                    onclick={() => toggleExpanded(virtualRow.row.original)}
                    title={virtualRow.row.getIsExpanded() ? 'Collapse campaign' : 'Expand campaign'}
                    type="button"
                  >
                    {virtualRow.row.getIsExpanded() ? 'Hide children' : 'Show children'}
                  </button>
                {/if}
              </div>
              <footer class={mobileMeta}>
                {#if mobileFresh.kind === 'value' && mobileCache.kind === 'value' && mobileDuration.kind === 'value'}
                  <span title={mobileFresh.title}>{mobileFresh.label} fresh</span>
                  · <span title={mobileCache.title}>{mobileCache.label} cache</span>
                  · <span title={mobileDuration.title}>{mobileDuration.label}</span>
                {/if}
              </footer>
            </article>
          </li>
        {/each}
        {#if virtual.bottomHeight > 0}
          <li aria-hidden="true" data-virtual-spacer="bottom" style:height={`${virtual.bottomHeight}px`}></li>
        {/if}
        <li aria-hidden="true" data-session-paging-sentinel="mobile" style:height="1px"></li>
      </ul>
    {/if}

    {#each rows.filter((row) => row.campaignKey && (typeof expanded === 'object' && expanded[row.rowId])) as row (row.rowId)}
      {@const campaign = row.campaignKey ? campaignChildren.get(row.campaignKey) : undefined}
      {#if row.campaignKey && (campaign?.loading || campaign?.nextCursor)}
        <div class={paging}>
          <button
            class={controlButton}
            disabled={campaign.loading}
            onclick={() => onLoadCampaignChildren?.(row.campaignKey!)}
            type="button"
          >
            {campaign.loading ? 'Loading campaign sessions…' : `Load more sessions in ${row.sessionLabel}`}
          </button>
        </div>
      {/if}
    {/each}
    {#if loadingMoreRows}
      <div aria-live="polite" class={paging}>Loading more sessions…</div>
    {/if}
  </section>
{/if}
