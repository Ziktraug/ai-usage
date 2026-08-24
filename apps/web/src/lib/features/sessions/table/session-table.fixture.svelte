<script lang="ts">
  import type { TitleSource } from '@ai-usage/report-core/types';
  import type { SessionSurfaceMode } from '../../../../session-surface-mode';
  import { columnVisibilityForSessionPreset, type SessionColumnPresetId } from '../../../../session-table-schema';
  import { syntheticCampaignRow, syntheticSessionRow, syntheticSessionRows } from './session-table.fixtures';
  import SessionTable from './session-table.svelte';

  let {
    childTitleSource,
    expanded = false,
    mode = 'desktop',
    preset = 'work',
    unavailable = false,
  }: {
    childTitleSource?: TitleSource;
    expanded?: boolean;
    mode?: Exclude<SessionSurfaceMode, 'pending'>;
    preset?: SessionColumnPresetId;
    unavailable?: boolean;
  } = $props();
  const child = $derived(
    childTitleSource ? { ...syntheticSessionRow(2), titleSource: childTitleSource } : syntheticSessionRow(2),
  );
  const campaign = $derived({
    ...syntheticCampaignRow(1, [child]),
    campaignClassifierCount: 1,
    campaignClassifierFreshTokens: 1200,
    costApprox: 1.2,
    costKnown: false,
    partial: true,
    titleSource: 'first-prompt' as const,
    usageUnavailable: unavailable,
  });
  const singleton = syntheticCampaignRow(3);
  const filtered = { ...syntheticCampaignRow(4), campaignTotalCount: 3, campaignVisibleCount: 1 };
  const rows = $derived([campaign, singleton, filtered, ...syntheticSessionRows(4997, 10)]);
  const noop = () => undefined;
</script>

<SessionTable
  columnVisibility={columnVisibilityForSessionPreset(preset)}
  initialExpanded={expanded ? { [campaign.rowId]: true } : {}}
  initialSurfaceMode={mode}
  initialWindowAnchor
  onClearFilters={noop}
  onColumnVisibilityChange={noop}
  onFieldFilter={noop}
  onHarnessFilter={noop}
  onInitialWindowAnchor={noop}
  onLoadCampaignChildren={noop}
  onSelect={noop}
  onSortingChange={noop}
  queryResetKey="synthetic-query"
  {rows}
  searchQuery="session"
  selectedRowId={null}
  sorting={[{ desc: true, id: 'date' }]}
  totalRows={5000}
/>
