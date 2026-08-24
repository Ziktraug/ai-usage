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
  import {
    classifierRollupLabelForSessionRow,
    type SessionPresentationRow,
    type SessionQueryRequest,
  } from '@ai-usage/report-core/session-query';
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
    readonly rolledUpClassifierCount?: number;
    readonly visibleRows: readonly SessionPresentationRow[];
  }

  let {
    campaign,
    collection,
    onClearCampaignFilter,
    onLoadMoreCampaignSessions,
    onSelectSession,
    query,
    rolledUpClassifierCount = 0,
    visibleRows,
  }: Props = $props();
  let showAll = $state(false);
  let previousCampaignKey = $state('');
  const model = $derived(
    campaignSessionControlsModel({ campaign, collection, query, rolledUpClassifierCount, showAll, visibleRows }),
  );

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
  // The header states the campaign display row's own totals — the same numbers the
  // metric grid below renders — instead of re-aggregating the loaded member page.
  const campaignTotals = $derived(
    [
      `${apiValuePresentation(campaign).label} API`,
      `${fmtCompact(campaign.freshTokens)} fresh tokens`,
      `${fmtNum(campaign.turns)} turns`,
      `${fmtNum(campaign.tools)} tools`,
    ].join(' · '),
  );
  // Outside a narrowed filter, the suffix explains automated reviews not yet listed. Under
  // a filter, the adapter's exact rollup-only count takes precedence so a review returned
  // for complete campaign totals is never misreported as a matching or hidden session.
  // Reuse the canonical label so the count and pluralization keep one definition.
  const unlistedClassifierCount = $derived.by((): number => {
    const listed = (model?.sessions ?? []).filter(
      ({ row }) => row.origin === 'classifier' && row.rowId !== campaign.rowId,
    ).length;
    return Math.max(0, (campaign.campaignClassifierCount ?? 0) - listed);
  });
  const explainedClassifierCount = $derived(
    model?.rolledUpClassifierCount ? model.rolledUpClassifierCount : unlistedClassifierCount,
  );
  const classifierRollup = $derived(
    classifierRollupLabelForSessionRow({ ...campaign, campaignClassifierCount: explainedClassifierCount }),
  );
</script>

{#if model}
  <section class={drawerCompare} data-campaign-session-controls={model.campaignKey}>
    <div class={drawerTitle}>Campaign</div>
    <div data-campaign-totals style="margin-top: 6px">{campaignTotals}</div>
    <div class={muted} data-campaign-session-counts style="margin-top: 4px">
      {#if model.allSessionsLoaded}
        {fmtNum(model.visibleCount)}
        / {fmtNum(model.totalCount)} sessions {model.rolledUpClassifierCount > 0 ? 'match current filters' : 'shown'}
      {:else}
        {fmtNum(model.visibleCount)}
        / {fmtNum(model.totalCount)} sessions match current filters · {fmtNum(model.loadedCount)} /
        {fmtNum(model.totalCount)}
        sessions loaded
      {/if}
      {#if model.hiddenCount > 0}
        · {fmtNum(model.hiddenCount)} hidden by current filters
      {/if}
      {#if classifierRollup}
        · {classifierRollup}{model.rolledUpClassifierCount > 0 ? ' included in campaign totals' : ''}
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
