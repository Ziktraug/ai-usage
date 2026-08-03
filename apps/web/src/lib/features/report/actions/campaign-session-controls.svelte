<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const sessionButton = css({
    appearance: 'none',
    display: 'block',
    w: 'full',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    p: '10px',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const hiddenSession = css({ opacity: 0.58 });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
  import { fmtCompact, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import { button, list, muted, row, stack, title } from '../breakdown/styles';
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
</script>

{#if model}
  <section class={stack} data-campaign-session-controls={model.campaignKey}>
    <div>
      <div class={title}>Campaign</div>
      <div class={muted} data-campaign-session-counts>
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
    </div>

    <div class={list} data-campaign-session-list>
      {#each model.sessions as session (session.row.rowId)}
        <button
          class={cx(sessionButton, session.hidden && hiddenSession)}
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
      <div class={row}>
        {#if model.hiddenCount > 0}
          <button class={button} onclick={() => (showAll = !showAll)} type="button">
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
            class={button}
            disabled={model.loading}
            onclick={() => onLoadMoreCampaignSessions(model.campaignKey)}
            type="button"
          >
            {model.loading ? 'Loading more campaign sessions…' : 'Load more campaign sessions'}
          </button>
        {/if}
        {#if model.canClearCampaignFilter}
          <button class={button} onclick={() => onClearCampaignFilter(model.campaignKey)} type="button">
            Clear campaign filter
          </button>
        {/if}
      </div>
    {/if}
  </section>
{/if}
