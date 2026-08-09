<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/useValidAriaValues: virtualized rows preserve the legacy keyboard surface; Svelte emits the closed dynamic WAI-ARIA values asserted by SSR tests -->
<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    Checkbox,
    dateCell,
    desktopTableSurface,
    empty,
    emptyActions,
    ghostButton,
    HarnessBadge,
    highlightMark,
    mobileSummarySurface,
    modelCell,
    numCell,
    Popover,
    presetButton,
    presetGroup,
    right,
    sessionCell,
    sessionPagingLoadMore,
    sessionSummaryCard,
    sessionSummaryDate,
    sessionSummaryFilter,
    sessionSummaryFilters,
    sessionSummaryFooter,
    sessionSummaryHeader,
    sessionSummaryMobileSort,
    sessionSummaryMobileSortField,
    sessionSummaryMobileSortSelect,
    sessionSummaryOpen,
    sessionSummaryRow,
    sessionSummaryStats,
    sessionSummaryTitle,
    sessionSummaryValue,
    sessionSummaryViewport,
    sessionsTable,
    sessionViewportSurface,
    sortArrow,
    sortButton,
    table as tableClass,
    tableControls,
    tableWrap,
  } from '@ai-usage/design-system/svelte';
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
    sessionColumnSchema,
  } from '../../../../session-table-schema';
  import { fmtDate } from '../../../foundation/presentation/format';
  import type { StateChangeHandler, TableSortingState, TableVisibilityState } from '../../../foundation/table/state';
  import type { SessionCampaignPage } from '../../../query/options/session-window';
  import SessionCell from './session-cell.svelte';
  import {
    projectSessionCell,
    sessionSortDescendingByDefault,
    sessionSortForColumnChange,
    shouldSelectSessionRowForKey,
  } from './session-cell-projection';
  import { sessionTableColumns, visibleSessionTableColumns } from './session-columns';
  import { createSessionTableModel, toggleSessionRowExpanded } from './session-table-model';
  import { popoverGrid, popoverHeader } from './session-table-styles';
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
    initialWindowAnchor: boolean;
    loading?: boolean;
    loadingMoreRows?: boolean;
    onClearFilters: () => void;
    onColumnVisibilityChange: StateChangeHandler<TableVisibilityState>;
    onFieldFilter: (key: 'campaign' | 'model' | 'project' | 'provider', value: string) => void;
    onHarnessFilter: (value: string) => void;
    onInitialWindowAnchor: () => void;
    onLoadCampaignChildren?: (campaignKey: string) => void;
    onLoadMoreRows?: () => void;
    onSelect: (row: SessionPresentationRow) => void;
    onSortingChange: StateChangeHandler<TableSortingState>;
    queryResetKey: string;
    rows: SessionPresentationRow[];
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
    initialWindowAnchor,
    loading = false,
    loadingMoreRows = false,
    onClearFilters,
    onColumnVisibilityChange,
    onFieldFilter,
    onHarnessFilter,
    onInitialWindowAnchor,
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
  let initializedSurfaceElement = $state<HTMLElement>();
  let windowAnchorConsumed = $state(false);
  let previousResetKey = $state('');
  let pagingSignature = $state('');
  let pendingFocusIndex = $state<number>();

  const hasRtkData = $derived(rows.some((row) => Boolean(row.rtkSavedTokens)));
  const effectiveVisibility = $derived(hasRtkData ? columnVisibility : { ...columnVisibility, rtkSaved: false });
  const chooserColumns = $derived(
    sessionTableColumns.filter((entry) => entry.id !== 'session' && (entry.id !== 'rtkSaved' || hasRtkData)),
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
  const cellClass = (id: SessionColumnId, align: 'left' | 'right'): string =>
    cx(
      align === 'right' ? numCell : undefined,
      id === 'date' ? dateCell : undefined,
      id === 'model' ? modelCell : undefined,
      id === 'session' ? sessionCell : undefined,
    );

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
    // No window `scroll` listener: the height no longer depends on where the
    // surface sits, and recomputing it on scroll is what made the document grow
    // under the reader. The surface's own `onscroll` still drives the row window.
    const observer = new ResizeObserver(synchronize);
    observer.observe(activeSurface);
    window.addEventListener('resize', synchronize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', synchronize);
    };
  });

  $effect(() => {
    const activeSurface = surfaceElement;
    const regionStart = sessionRegionStartElement;
    const shouldAnchorWindow = initialWindowAnchor && !windowAnchorConsumed;
    if (initializedSurfaceElement === activeSurface || !activeSurface || (shouldAnchorWindow && !regionStart)) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      initializedSurfaceElement = activeSurface;
      activeSurface.style.removeProperty('--session-surface-height');
      if (shouldAnchorWindow) {
        windowAnchorConsumed = true;
        regionStart?.scrollIntoView({ block: 'start' });
        onInitialWindowAnchor();
      }
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
      <div class={emptyActions}>
        <span>No sessions match the current filters</span>
        <button class={ghostButton} onclick={onClearFilters} type="button">Clear filters</button>
      </div>
    {/if}
  </div>
{:else}
  <section aria-label="Sessions" data-session-mode={activeMode} data-session-table-owner>
    <div class={tableControls} data-session-region-start bind:this={sessionRegionStartElement}>
      {#if activeMode === 'desktop'}
        <fieldset aria-label="Session column presets" class={presetGroup}>
          {#each sessionColumnPresets as preset (preset.id)}
            {@const active = activePreset === preset.id}
            <button
              aria-pressed={active}
              class={presetButton}
              data-active={String(active)}
              data-default={String(preset.id === 'work')}
              onclick={() => onColumnVisibilityChange(columnVisibilityForSessionPreset(preset.id))}
              type="button"
            >
              {preset.label}
            </button>
          {/each}
          <Popover triggerClass={ghostButton}>
            {#snippet trigger()}
              Advanced columns · {visibleColumns.length} ▾
            {/snippet}
            <div class={popoverHeader}>
              <span>{visibleColumns.length} of {sessionColumnSchema.length} columns shown</span>
              <button
                class={ghostButton}
                onclick={() => onColumnVisibilityChange(defaultColumnVisibility)}
                type="button"
              >
                Reset
              </button>
            </div>
            <div class={popoverGrid}>
              {#each chooserColumns as entry (entry.id)}
                <Checkbox
                  checked={isSessionColumnVisible(columnVisibility, entry.id)}
                  onCheckedChange={(checked) => setColumnVisible(entry.id, checked)}
                >
                  {entry.meta.label}
                </Checkbox>
              {/each}
            </div>
          </Popover>
        </fieldset>
      {:else}
        <div class={sessionSummaryMobileSort}>
          <label class={sessionSummaryMobileSortField}>
            <span>Sort by</span>
            <select
              aria-label="Sort mobile session summaries"
              class={sessionSummaryMobileSortSelect}
              onchange={(event) => changeSortColumn(event.currentTarget.value as SessionColumnId)}
              value={activeSort.id}
            >
              {#each sessionTableColumns as entry (entry.id)}
                <option value={entry.id}>{entry.meta.label}</option>
              {/each}
            </select>
          </label>
          <button
            aria-label={activeSort.desc ? 'Sort ascending' : 'Sort descending'}
            class={ghostButton}
            onclick={() => changeSort(activeSort.id as SessionColumnId)}
            type="button"
          >
            {activeSort.desc ? 'Descending ↓' : 'Ascending ↑'}
          </button>
        </div>
      {/if}
    </div>

    {#if activeMode === 'desktop'}
      <div
        class={cx(tableWrap, sessionViewportSurface, desktopTableSurface)}
        data-session-surface="desktop"
        onscroll={updateViewport}
        bind:this={surfaceElement}
        use:setSurfaceElement
      >
        <table
          aria-rowcount={totalRows ?? model.rows.length}
          class={cx(tableClass, sessionsTable)}
          style:min-width={`${tableMinWidth}px`}
        >
          <thead>
            <tr>
              {#each visibleColumns as entry (entry.id)}
                <th
                  aria-sort={ariaSortFor(entry.id)}
                  class={entry.meta.align === 'right' ? right : undefined}
                  scope="col"
                  title={entry.meta.title}
                  style:width={columnWidth(entry.meta.widthPx)}
                >
                  <button class={sortButton} onclick={() => changeSort(entry.id)} type="button">
                    <span>{typeof entry.header === 'string' ? entry.header : entry.meta.label}</span>
                    {#if activeSort.id === entry.id}
                      <span aria-hidden="true" class={sortArrow}>{activeSort.desc ? '↓' : '↑'}</span>
                    {/if}
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#if virtual.topHeight > 0}
              <tr aria-hidden="true" data-virtual-spacer="top">
                <td
                  colspan={visibleColumns.length}
                  style:border="0"
                  style:height={`${virtual.topHeight}px`}
                  style:padding="0"
                ></td>
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
                  <td class={cellClass(entry.id, entry.meta.align)}>
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
                <td
                  colspan={visibleColumns.length}
                  style:border="0"
                  style:height={`${virtual.bottomHeight}px`}
                  style:padding="0"
                ></td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {:else}
      <ul
        aria-label="Session summaries"
        class={cx(mobileSummarySurface, sessionSummaryViewport, sessionViewportSurface)}
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
            class={sessionSummaryRow}
            data-depth={virtualRow.row.depth}
            data-index={virtualRow.index}
            data-session-row-height="188"
            data-session-row-id={virtualRow.row.id}
          >
            <article
              class={sessionSummaryCard}
              data-depth={virtualRow.row.depth}
              data-selected={selectedRowId === virtualRow.row.id}
              data-session-card-height="180"
            >
              <header class={sessionSummaryHeader}>
                <span class={sessionSummaryDate}>{fmtDate(virtualRow.row.original.activeDate)}</span>
                <HarnessBadge
                  name={virtualRow.row.original.harness}
                  onClick={() => onHarnessFilter(virtualRow.row.original.harness)}
                />
              </header>
              <button
                aria-label={mobileSession.kind === 'session'
                  ? `Inspect session: ${mobileSession.segments.map(({ text }) => text).join('')}`
                  : undefined}
                class={sessionSummaryOpen}
                data-session-index={virtualRow.index}
                onclick={() => onSelect(virtualRow.row.original)}
                onkeydown={(event) => onRowKeydown(event, virtualRow.row.original, virtualRow.index, false)}
                tabindex="0"
                type="button"
              >
                <span class={sessionSummaryTitle}>
                  {#if mobileSession.kind === 'session'}
                    {#each mobileSession.segments as segment, index (`mobile:${index}:${segment.text}`)}
                      {#if segment.match}
                        <mark class={highlightMark}>{segment.text}</mark>
                      {:else}
                        {segment.text}
                      {/if}
                    {/each}
                  {/if}
                </span>
                {#if mobileValue.kind === 'value'}
                  <span class={sessionSummaryValue} title={mobileValue.title}>{mobileValue.label}</span>
                {/if}
              </button>
              <footer class={sessionSummaryFooter}>
                <div class={sessionSummaryFilters}>
                  <button
                    class={sessionSummaryFilter}
                    onclick={() => onFieldFilter('project', virtualRow.row.original.projectKey)}
                    title={`Filter by project ${virtualRow.row.original.projectLabel}`}
                    type="button"
                  >
                    {virtualRow.row.original.projectLabel === '(unknown)'
                      ? 'No project'
                      : virtualRow.row.original.projectLabel}
                  </button>
                  <button
                    class={sessionSummaryFilter}
                    onclick={() => onFieldFilter('model', virtualRow.row.original.modelKey)}
                    title={`Filter by model ${virtualRow.row.original.modelKey}`}
                    type="button"
                  >
                    {virtualRow.row.original.modelLabel}
                  </button>
                  {#if virtualRow.row.getCanExpand()}
                    <button
                      class={sessionSummaryFilter}
                      onclick={() => toggleExpanded(virtualRow.row.original)}
                      title={virtualRow.row.getIsExpanded() ? 'Collapse campaign' : 'Expand campaign'}
                      type="button"
                    >
                      {virtualRow.row.getIsExpanded() ? 'Hide children' : 'Show children'}
                    </button>
                  {/if}
                </div>
                <span class={sessionSummaryStats}>
                  {#if mobileFresh.kind === 'value' && mobileCache.kind === 'value' && mobileDuration.kind === 'value'}
                    <span title={mobileFresh.title}>{mobileFresh.label} fresh</span>
                    · <span title={mobileCache.title}>{mobileCache.label} cache</span>
                    · <span title={mobileDuration.title}>{mobileDuration.label}</span>
                  {/if}
                </span>
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
        <div class={sessionPagingLoadMore}>
          <button
            class={ghostButton}
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
      <div aria-live="polite" class={sessionPagingLoadMore}>Loading more sessions…</div>
    {/if}
  </section>
{/if}
