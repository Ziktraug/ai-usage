<script lang="ts">
  import type {
    SessionPageItem,
    SessionPresentationRow,
    SessionQueryRequest,
  } from '@ai-usage/report-core/session-query';
  import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
  import type { DashboardSearch } from '../../../../dashboard-search';
  import {
    sessionAnalysisTargetForPageItem,
    sessionAnalysisTargetForSession,
  } from '../../../../session-analysis-target';
  import {
    columnVisibilityFromDiff,
    columnVisibilitySearchForVisibility,
    sortFromSortingState,
  } from '../../../../session-table-schema';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import { applyStateUpdate } from '../../../foundation/table/state';
  import {
    projectSessionDestinationRows,
    type SessionWindowIntent,
    type SessionWindowQueryData,
    type SessionWindowView,
    sessionWindowView,
  } from '../../../query/options/session-window';
  import type { SessionSelectionInput } from '../../sessions/detail/types';
  import SessionTable from '../../sessions/table/session-table.svelte';
  import {
    type CampaignSessionControlsBinding,
    campaignSessionsNeedInitialLoad,
  } from '../actions/campaign-session-controls-binding';
  import type { SessionQueryScopeSnapshot } from './report-search';
  import SessionIdentityPublisher from './session-identity-publisher.svelte';
  import SessionsDestinationState from './sessions-destination-state.svelte';

  let {
    navigate,
    initialSessionWindowAnchor,
    onCampaignControlsChange,
    onInitialSessionWindowAnchor,
    onRowsChange,
    onSessionCountChange,
    onSelectionChange,
    presentRow,
    pending,
    onIncreaseQueryDepth,
    queryData,
    queryIntent,
    destinationScope,
    search,
    selectedCampaignKey,
    selectedRowId,
  }: {
    initialSessionWindowAnchor: boolean;
    navigate: SearchNavigationIntent<DashboardSearch>;
    onCampaignControlsChange: (binding: CampaignSessionControlsBinding | null) => void;
    onInitialSessionWindowAnchor: () => void;
    onRowsChange: (rows: readonly SessionPresentationRow[]) => void;
    onSessionCountChange: (sessionCount: number | undefined) => void;
    onSelectionChange: (selection: SessionSelectionInput | null) => void;
    presentRow: (row: SessionPresentationRow) => SessionPresentationRow;
    pending: boolean;
    onIncreaseQueryDepth: (
      family: 'campaign-children' | 'campaign-sessions' | 'top-level',
      campaignKey?: string,
    ) => void;
    queryData: SessionWindowQueryData | undefined;
    queryIntent: SessionWindowIntent;
    destinationScope: SessionQueryScopeSnapshot;
    search: DashboardSearch;
    selectedCampaignKey: string | undefined;
    selectedRowId: string | null;
  } = $props();

  const columnVisibility = $derived(columnVisibilityFromDiff(search.cols, search.colsBase));
  const sorting = $derived([{ ...search.sort }]);
  const queryState = $derived<SessionWindowView | undefined>(
    queryData === undefined ? undefined : sessionWindowView(queryData, queryIntent, pending),
  );
  const query = $derived(queryState?.query);
  const resetKey = $derived(query ? sessionQueryFingerprint(query) : JSON.stringify(destinationScope));

  const selectRow = (
    row: SessionPresentationRow,
    items: readonly SessionPageItem[],
    query: SessionQueryRequest | undefined,
    total: number,
  ): void => {
    if (selectedRowId === row.rowId) {
      onSelectionChange(null);
      return;
    }
    if (!query) {
      return;
    }
    const pageItem = items.find((item) =>
      row.campaignKey === undefined ? item.row.rowId === row.rowId : item.campaignKey === row.campaignKey,
    );
    onSelectionChange({
      query,
      row,
      target:
        pageItem === undefined
          ? sessionAnalysisTargetForSession(row)
          : sessionAnalysisTargetForPageItem({ ...pageItem, row }),
      total,
    });
  };
</script>

<SessionIdentityPublisher
  requestFingerprint={query ? sessionQueryFingerprint(query) : undefined}
  revision={query?.revision}
/>
<SessionsDestinationState
  {onCampaignControlsChange}
  {onIncreaseQueryDepth}
  {onRowsChange}
  {onSessionCountChange}
  {presentRow}
  {queryState}
  {selectedCampaignKey}
  sessionCount={queryState?.sessionCount}
  sourceRows={queryState === undefined ? [] : projectSessionDestinationRows(queryState)}
>
  {#snippet children(_rows)}
    <SessionTable
      {...(queryState?.campaignChildren === undefined
        ? {}
        : { campaignChildren: queryState.campaignChildren })}
      {columnVisibility}
      hasMoreRows={Boolean(queryState?.nextCursor)}
      initialWindowAnchor={initialSessionWindowAnchor}
      loading={pending && !queryState}
      loadingMoreRows={queryState?.loadingMore ?? false}
      onClearFilters={() => navigate((current) => ({ ...current, filters: {}, harness: [], machine: [], origin: [], q: '', range: { mode: '30d' } }))}
      onColumnVisibilityChange={(updater) => {
        const next = applyStateUpdate(updater, columnVisibility);
        const columnSearch = columnVisibilitySearchForVisibility(next);
        navigate((current) => ({ ...current, ...columnSearch }), { replace: true });
      }}
      onFieldFilter={(key, value) => navigate((current) => ({ ...current, filters: { ...current.filters, [key]: value } }))}
      onHarnessFilter={(value) => navigate((current) => ({ ...current, harness: current.harness.includes(value) ? current.harness.filter((item) => item !== value) : [...current.harness, value] }))}
      onInitialWindowAnchor={onInitialSessionWindowAnchor}
      onLoadCampaignChildren={(campaignKey) => onIncreaseQueryDepth('campaign-children', campaignKey)}
      onLoadMoreRows={() => onIncreaseQueryDepth('top-level')}
      onSelect={(row) => {
        if (
          selectedRowId !== row.rowId &&
          row.campaignKey !== undefined &&
          campaignSessionsNeedInitialLoad(queryState?.campaignSessions, row.campaignKey)
        ) {
          onIncreaseQueryDepth('campaign-sessions', row.campaignKey);
        }
        selectRow(row, queryState?.items ?? [], query, queryState?.sessionCount ?? _rows.length);
      }}
      onSortingChange={(updater) => {
        const next = applyStateUpdate(updater, sorting);
        navigate((current) => ({ ...current, sort: sortFromSortingState(next, current.sort) }));
      }}
      queryResetKey={resetKey}
      rows={_rows}
      searchQuery={query?.filters.query ?? ''}
      {selectedRowId}
      {sorting}
      {...(queryState?.itemCount === undefined ? {} : { totalRows: queryState.itemCount })}
    />
  {/snippet}
</SessionsDestinationState>
