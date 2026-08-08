<script lang="ts">
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { onDestroy, type Snippet, untrack } from 'svelte';
  import type { SessionWindowView } from '../../../query/options/session-window';
  import {
    type CampaignSessionControlsBinding,
    campaignSessionSelectionQuery,
    createCampaignSessionControlsPublisher,
  } from '../actions/campaign-session-controls-binding';
  import { campaignSessionControlsState } from '../actions/campaign-session-controls-model';

  let {
    children,
    onCampaignControlsChange,
    onRowsChange,
    onSessionCountChange,
    presentRow,
    onIncreaseQueryDepth,
    queryState,
    selectedCampaignKey,
    sessionCount,
    sourceRows,
  }: {
    children: Snippet<[readonly SessionPresentationRow[]]>;
    onCampaignControlsChange: (binding: CampaignSessionControlsBinding | null) => void;
    onRowsChange: (rows: readonly SessionPresentationRow[]) => void;
    onSessionCountChange: (sessionCount: number | undefined) => void;
    presentRow: (row: SessionPresentationRow) => SessionPresentationRow;
    onIncreaseQueryDepth: (
      family: 'campaign-children' | 'campaign-sessions' | 'top-level',
      campaignKey?: string,
    ) => void;
    queryState: SessionWindowView | undefined;
    selectedCampaignKey: string | undefined;
    sessionCount: number | undefined;
    sourceRows: readonly SessionPresentationRow[];
  } = $props();

  const rows = $derived(sourceRows.map(presentRow));
  const campaignPublisher = untrack(() => createCampaignSessionControlsPublisher(() => onCampaignControlsChange));
  const selectedCampaign = $derived(
    selectedCampaignKey === undefined ? undefined : rows.find((row) => row.campaignKey === selectedCampaignKey),
  );
  const campaignState = $derived(
    selectedCampaign === undefined ? null : campaignSessionControlsState(queryState, selectedCampaign),
  );
  const campaignBinding = $derived.by((): CampaignSessionControlsBinding | null => {
    if (!(campaignState && selectedCampaign && queryState)) {
      return null;
    }
    const campaignKey = selectedCampaign.campaignKey;
    if (campaignKey === undefined) {
      return null;
    }
    return {
      campaign: selectedCampaign,
      collection: {
        ...campaignState.collection,
        items: campaignState.collection.items.map(presentRow),
      },
      loadMore: () => {
        onIncreaseQueryDepth('campaign-sessions', campaignKey);
      },
      query: queryState.query,
      selectionQuery: campaignSessionSelectionQuery(queryState.query, campaignKey),
      sessionCount: campaignState.collection.totalCount,
      visibleRows: campaignState.visibleRows.map(presentRow),
    };
  });

  $effect(() => {
    onRowsChange(rows);
    onSessionCountChange(sessionCount);
    campaignPublisher.publish(campaignBinding);
  });
  onDestroy(campaignPublisher.dispose);
</script>

{@render children(rows)}
