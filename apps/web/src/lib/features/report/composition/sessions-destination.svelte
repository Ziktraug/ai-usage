<script lang="ts">
  import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
  import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
  import type { QueryClient } from '@tanstack/svelte-query';
  import type { DashboardSearch } from '../../../../dashboard-search';
  import { sessionAnalysisTargetForSession } from '../../../../session-analysis-target';
  import {
    columnVisibilityFromDiff,
    columnVisibilitySearchForVisibility,
    sortFromSortingState,
  } from '../../../../session-table-schema';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import { applyStateUpdate } from '../../../foundation/table/state';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import type { SessionSelectionInput } from '../../sessions/detail/controller';
  import SessionTable from '../../sessions/table/session-table.svelte';
  import SessionTableOwner from '../../sessions/table/session-table-owner.svelte';
  import type { FocusedReportDescriptor } from './report-destination';
  import type { SessionQueryScopeSnapshot } from './report-search';
  import SessionDestinationRefresh from './session-destination-refresh.svelte';

  let {
    acquire,
    client,
    navigate,
    onRowsChange,
    onSelectionChange,
    presentRow,
    queryClient,
    destinationScope,
    search,
    selectedRowId,
  }: {
    acquire: (signal: AbortSignal) => Promise<FocusedReportDescriptor>;
    client: SessionClientAdapter;
    navigate: SearchNavigationIntent<DashboardSearch>;
    onRowsChange: (rows: readonly SessionPresentationRow[]) => void;
    onSelectionChange: (selection: SessionSelectionInput | null) => void;
    presentRow: (row: SessionPresentationRow) => SessionPresentationRow;
    queryClient: QueryClient;
    destinationScope: SessionQueryScopeSnapshot;
    search: DashboardSearch;
    selectedRowId: string | null;
  } = $props();

  const columnVisibility = $derived(columnVisibilityFromDiff(search.cols, search.colsBase));
  const sorting = $derived([{ ...search.sort }]);

  const updateRows = (rows: readonly SessionPresentationRow[]): readonly SessionPresentationRow[] => {
    const presented = rows.map(presentRow);
    onRowsChange(presented);
    return presented;
  };

  const selectRow = (row: SessionPresentationRow, query: SessionQueryRequest | undefined, total: number): void => {
    if (selectedRowId === row.rowId) {
      onSelectionChange(null);
      return;
    }
    if (!query) {
      return;
    }
    onSelectionChange({
      query,
      row,
      target: sessionAnalysisTargetForSession(row),
      total,
    });
  };
</script>

<SessionTableOwner {acquire} {client} {queryClient}>
  {#snippet children(_owned)}
    {@const rows = updateRows(_owned.rows)}
    {@const query = _owned.snapshot?.query}
    {@const resetKey = query ? sessionQueryFingerprint(query) : JSON.stringify(destinationScope)}
    <SessionDestinationRefresh {destinationScope} owner={_owned.lifecycle} />
    <SessionTable
      {...(_owned.snapshot?.campaignChildren === undefined
        ? {}
        : { campaignChildren: _owned.snapshot.campaignChildren })}
      {columnVisibility}
      hasMoreRows={Boolean(_owned.snapshot?.nextCursor)}
      loading={_owned.lifecycle.snapshot.pending && !_owned.snapshot}
      loadingMoreRows={_owned.snapshot?.loadingMore ?? false}
      onClearFilters={() => navigate((current) => ({ ...current, filters: {}, harness: [], machine: [], origin: [], q: '', range: { mode: '30d' } }))}
      onColumnVisibilityChange={(updater) => {
        const next = applyStateUpdate(updater, columnVisibility);
        const columnSearch = columnVisibilitySearchForVisibility(next);
        navigate((current) => ({ ...current, ...columnSearch }), { replace: true });
      }}
      onFieldFilter={(key, value) => navigate((current) => ({ ...current, filters: { ...current.filters, [key]: value } }))}
      onHarnessFilter={(value) => navigate((current) => ({ ...current, harness: current.harness.includes(value) ? current.harness.filter((item) => item !== value) : [...current.harness, value] }))}
      onLoadCampaignChildren={(campaignKey) => _owned.query.loadCampaignChildren(campaignKey).catch(() => undefined)}
      onLoadMoreRows={() => _owned.query.loadMore().catch(() => undefined)}
      onSelect={(row) => selectRow(row, query, _owned.snapshot?.sessionCount ?? rows.length)}
      onSortingChange={(updater) => {
        const next = applyStateUpdate(updater, sorting);
        navigate((current) => ({ ...current, sort: sortFromSortingState(next, current.sort) }));
      }}
      queryResetKey={resetKey}
      {rows}
      searchQuery={query?.filters.query ?? ''}
      {selectedRowId}
      {sorting}
      {...(_owned.snapshot?.itemCount === undefined ? {} : { totalRows: _owned.snapshot.itemCount })}
    />
  {/snippet}
</SessionTableOwner>
