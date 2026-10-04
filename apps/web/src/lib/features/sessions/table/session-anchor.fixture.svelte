<script lang="ts">
  import { columnVisibilityForSessionPreset } from '../../../../session-table-schema';
  import { syntheticSessionRows } from './session-table.fixtures';
  import SessionTable from './session-table.svelte';

  let inserted = $state(false);
  const initialRows = syntheticSessionRows(300, 1000);
  const rows = $derived([...(inserted ? syntheticSessionRows(60, 100_000) : []), ...initialRows]);
  const noop = () => undefined;
  const changeRevision = (event: KeyboardEvent) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyR') {
      event.preventDefault();
      inserted = true;
    }
  };
</script>

<!-- biome-ignore lint/a11y/noStaticElementInteractions: the fixture keyboard shortcut preserves row focus while publishing synthetic data -->
<svelte:window onkeydown={changeRevision} />
<SessionTable
  columnVisibility={columnVisibilityForSessionPreset('work')}
  initialWindowAnchor={false}
  onClearFilters={noop}
  onColumnVisibilityChange={noop}
  onFieldFilter={noop}
  onHarnessFilter={noop}
  onInitialWindowAnchor={noop}
  onSelect={noop}
  onSortingChange={noop}
  queryResetKey="synthetic-anchor-query"
  {rows}
  selectedRowId={null}
  sorting={[{ desc: true, id: 'date' }]}
  totalRows={rows.length}
/>
