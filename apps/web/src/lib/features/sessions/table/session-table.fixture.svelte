<script lang="ts">
  import type { SessionSurfaceMode } from '../../../../session-surface-mode';
  import { defaultColumnVisibility } from '../../../../session-table-schema';
  import { syntheticCampaignRow, syntheticSessionRow, syntheticSessionRows } from './session-table.fixtures';
  import SessionTable from './session-table.svelte';

  let {
    mode = 'desktop',
  }: {
    mode?: Exclude<SessionSurfaceMode, 'pending'>;
  } = $props();
  const campaign = {
    ...syntheticCampaignRow(1, [syntheticSessionRow(2)]),
    campaignClassifierCount: 1,
    campaignClassifierFreshTokens: 1200,
    costApprox: 1.2,
    costKnown: false,
    partial: true,
    titleSource: 'first-prompt' as const,
  };
  const rows = [campaign, ...syntheticSessionRows(4999, 10)];
  const noop = () => undefined;
</script>

<SessionTable
  columnVisibility={defaultColumnVisibility}
  initialSurfaceMode={mode}
  onClearFilters={noop}
  onColumnVisibilityChange={noop}
  onFieldFilter={noop}
  onHarnessFilter={noop}
  onSelect={noop}
  onSortingChange={noop}
  queryResetKey="synthetic-query"
  {rows}
  searchQuery="session"
  selectedRowId={null}
  sorting={[{ desc: true, id: 'date' }]}
  totalRows={5000}
/>
