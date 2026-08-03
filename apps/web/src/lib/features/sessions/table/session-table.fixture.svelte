<script lang="ts">
  import { defaultColumnVisibility } from '../../../../session-table-schema';
  import { syntheticCampaignRow, syntheticSessionRow } from './session-table.fixtures';
  import SessionTable from './session-table.svelte';

  const rows = [syntheticCampaignRow(1, [syntheticSessionRow(2)]), syntheticSessionRow(3)];
  const noop = () => undefined;
</script>

<SessionTable
  columnVisibility={defaultColumnVisibility}
  onClearFilters={noop}
  onColumnVisibilityChange={noop}
  onFieldFilter={noop}
  onHarnessFilter={noop}
  onSelect={noop}
  onSortingChange={noop}
  queryResetKey="synthetic-query"
  {rows}
  selectedRowId={null}
  sorting={[{ desc: true, id: 'date' }]}
  totalRows={5000}
/>
