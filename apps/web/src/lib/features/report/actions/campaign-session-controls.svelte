<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const drawerCompare = css({ color: 'muted', fontSize: '12px' });
  const drawerTitle = css({ fontSize: '15px', fontWeight: 650, lineHeight: '1.35', overflowWrap: 'anywhere' });
  const drawerActions = css({ display: 'flex', flexWrap: 'wrap', gap: '8px' });
  const ghostButton = css({
    display: 'block',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'muted',
    px: '12px',
    py: '5px',
    fontSize: '12px',
    fontWeight: 600,
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const hiddenSession = css({ opacity: 0.58 });
  const campaignList = css({ display: 'grid', gap: '8px', mt: '10px' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
  import { fmtCompact, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import { muted } from '../breakdown/styles';
  import { type CampaignSessionCollection, campaignSessionControlsModel } from './campaign-session-controls-model';

  interface Props {
    readonly campaign: SessionPresentationRow;
    readonly collection: CampaignSessionCollection;
    readonly onClearCampaignFilter: (campaignKey: string) => void;
    readonly onLoadMoreCampaignSessions: (campaignKey: string) => void;
    readonly onSelectSession: (row: SessionPresentationRow) => void;
    readonly query: SessionQueryRequest;
    readonly visibleRows: readonly SessionPresentationRow[];
  }

  let {
    campaign,
    collection,
    onClearCampaignFilter,
    onLoadMoreCampaignSessions,
    onSelectSession,
    query,
    visibleRows,
  }: Props = $props();
  let showAll = $state(false);
  let previousCampaignKey = $state('');
  const model = $derived(campaignSessionControlsModel({ campaign, collection, query, showAll, visibleRows }));
  const visibleTotals = $derived({
    costApprox: visibleRows.reduce((sum, row) => sum + row.costApprox, 0),
    costKnown: visibleRows.every((row) => row.costKnown),
    freshTokens: visibleRows.reduce((sum, row) => sum + row.freshTokens, 0),
    tools: visibleRows.reduce((sum, row) => sum + row.tools, 0),
    turns: visibleRows.reduce((sum, row) => sum + row.turns, 0),
  });

  $effect(() => {
    const campaignKey = campaign.campaignKey ?? '';
    if (campaignKey === previousCampaignKey) {
      return;
    }
    previousCampaignKey = campaignKey;
    showAll = false;
  });

  const sessionSummary = (session: SessionPresentationRow): string => {
    const apiValue = apiValuePresentation(session);
    return [
      `${apiValue.label} API`,
      `${fmtCompact(session.freshTokens)} fresh`,
      `${fmtNum(session.turns)} turns`,
      `${fmtNum(session.tools)} tools`,
    ].join(' · ');
  };
  const campaignTotals = $derived(
    [
      `${apiValuePresentation(visibleTotals).label} API`,
      `${fmtCompact(visibleTotals.freshTokens)} fresh tokens`,
      `${fmtNum(visibleTotals.turns)} turns`,
      `${fmtNum(visibleTotals.tools)} tools`,
    ].join(' · '),
  );
</script>

{#if model}
  <section class={drawerCompare} data-campaign-session-controls={model.campaignKey}>
    <div class={drawerTitle}>Campaign</div>
    <div style="margin-top: 6px">{campaignTotals}</div>
    <div class={muted} data-campaign-session-counts style="margin-top: 4px">
      {#if model.allSessionsLoaded}
        {fmtNum(model.visibleCount)}
        / {fmtNum(model.totalCount)} sessions shown
      {:else}
        {fmtNum(model.visibleCount)}
        / {fmtNum(model.totalCount)} sessions match current filters · {fmtNum(model.loadedCount)} /
        {fmtNum(model.totalCount)}
        sessions loaded
      {/if}
      {#if model.hiddenCount > 0}
        · {fmtNum(model.hiddenCount)} hidden by current filters
      {/if}
    </div>

    <div class={campaignList} data-campaign-session-list>
      {#each model.sessions as session (session.row.rowId)}
        <button
          class={cx(ghostButton, session.hidden && hiddenSession)}
          data-campaign-session-row-id={session.row.rowId}
          onclick={() => onSelectSession(session.row)}
          title={session.hidden ? 'Select session hidden by current filters' : 'Select campaign session'}
          type="button"
        >
          <div>{session.row.sessionLabel}</div>
          <div class={muted}>
            {sessionSummary(session.row)}
            {#if session.hidden}
              · hidden by current filters
            {/if}
          </div>
        </button>
      {/each}
    </div>

    {#if model.hiddenCount > 0 || model.canLoadMore || model.loading || model.canClearCampaignFilter}
      <div class={drawerActions} style="margin-top: 10px">
        {#if model.hiddenCount > 0}
          <button class={ghostButton} onclick={() => (showAll = !showAll)} type="button">
            {#if showAll}
              Show filtered campaign sessions
            {:else if model.allSessionsLoaded}
              Show all campaign sessions
            {:else}
              Show loaded campaign sessions
            {/if}
          </button>
        {/if}
        {#if model.canLoadMore || model.loading}
          <button
            class={ghostButton}
            disabled={model.loading}
            onclick={() => onLoadMoreCampaignSessions(model.campaignKey)}
            type="button"
          >
            {model.loading ? 'Loading more campaign sessions…' : 'Load more campaign sessions'}
          </button>
        {/if}
        {#if model.canClearCampaignFilter}
          <button class={ghostButton} onclick={() => onClearCampaignFilter(model.campaignKey)} type="button">
            Clear campaign filter
          </button>
        {/if}
      </div>
    {/if}
  </section>
{/if}
