<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const shell = css({ color: 'muted', fontSize: '12px', minW: 0 });
  const title = css({ fontSize: '15px', fontWeight: 650, lineHeight: '1.35' });
  const note = css({ mt: '6px', mb: 0, overflowWrap: 'anywhere' });
  const list = css({ mt: '16px', '& [data-campaign-scroll]': { maxH: 'var(--session-members-height, 420px)' } });
  const button = css({
    display: 'block',
    w: 'full',
    minH: '44px',
    border: 0,
    borderTop: '1px solid token(colors.line)',
    bg: 'transparent',
    color: 'muted',
    px: '4px',
    py: '12px',
    fontSize: '12px',
    fontWeight: 600,
    textAlign: 'left',
    overflowWrap: 'anywhere',
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
</script>

<script lang="ts">
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { onMount } from 'svelte';
  import { fmtCompact, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import CampaignVirtualList from '../../campaigns/campaign-virtual-list.svelte';

  let {
    campaign,
    rows,
    totalCount,
    hasNextPage,
    loading,
    error: failure,
    expired,
    onNearEnd,
    onRetry,
    onSelectMember,
  }: {
    campaign: SessionPresentationRow;
    rows: readonly SessionPresentationRow[];
    totalCount: number | undefined;
    hasNextPage: boolean;
    loading: boolean;
    error: Error | null;
    expired: boolean;
    onNearEnd: () => boolean;
    onRetry: () => Promise<void>;
    onSelectMember: (row: SessionPresentationRow) => void;
  } = $props();
  let listElement = $state<HTMLDivElement>();
  let availableHeight = $state(420);
  const virtualRows = $derived(rows.map((row) => ({ key: row.rowId, row })));
  const campaignTotals = $derived(
    [
      `${apiValuePresentation(campaign).label} API`,
      `${fmtCompact(campaign.freshTokens)} fresh tokens`,
      `${fmtNum(campaign.turns)} turns`,
      `${fmtNum(campaign.tools)} tools`,
    ].join(' · '),
  );
  const sessionSummary = (row: SessionPresentationRow): string =>
    [
      `${apiValuePresentation(row).label} API`,
      `${fmtCompact(row.freshTokens)} fresh`,
      `${fmtNum(row.turns)} turns`,
      `${fmtNum(row.tools)} tools`,
    ].join(' · ');

  onMount(() => {
    const host = listElement;
    const body = host?.closest<HTMLElement>('[data-session-drawer-body]');
    if (!(host && body)) {
      return;
    }
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      if (host.getClientRects().length > 0 && !host.closest('[hidden], [inert]')) {
        availableHeight = Math.max(
          220,
          Math.floor(body.getBoundingClientRect().bottom - host.getBoundingClientRect().top - body.scrollTop - 16),
        );
      }
    };
    const schedule = (): void => {
      if (!frame) {
        frame = requestAnimationFrame(measure);
      }
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    for (
      let ancestor: HTMLElement | null = host;
      ancestor && ancestor !== body.parentElement;
      ancestor = ancestor.parentElement
    ) {
      resize.observe(ancestor);
      mutations.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] });
    }
    body.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      body.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  });
</script>

<section class={shell} data-campaign-session-controls={campaign.campaignKey}>
  <div class={title}>Campaign</div>
  <div class={note} data-campaign-totals>{campaignTotals}</div>
  <p class={note} data-session-members-scope>
    All campaign members, including automated reviews. Report filters stay applied to the report and its campaign
    totals.
  </p>
  <div class={note} data-campaign-session-counts>
    {#if totalCount !== undefined}
      {fmtNum(rows.length)}
      / {fmtNum(totalCount)} sessions {hasNextPage ? 'loaded' : 'shown'}
    {:else}
      Members have not loaded yet.
    {/if}
  </div>

  <div
    class={list}
    data-campaign-session-list
    bind:this={listElement}
    style:--session-members-height={`${availableHeight}px`}
  >
    <CampaignVirtualList estimate={72} label="Campaign members" {onNearEnd} rows={virtualRows} surface="list">
      {#snippet children(_member)}
        <button
          class={button}
          data-campaign-session-row-id={_member.row.rowId}
          onclick={() => onSelectMember(_member.row)}
          title="Select campaign session"
          type="button"
        >
          <div>{_member.row.sessionLabel}</div>
          <div>{sessionSummary(_member.row)}</div>
        </button>
      {/snippet}
      {#snippet footer()}
        {#if failure}
          <p class={note} data-session-members-error role="status">
            {expired
              ? 'This report revision expired. Close the detail and apply the latest publication to continue.'
              : 'Campaign members could not be loaded. The loaded members remain available.'}
          </p>
          {#if !expired}
            <button class={button} disabled={loading} onclick={onRetry} type="button">Retry campaign members</button>
          {/if}
        {:else if loading}
          <p class={note} role="status">Loading campaign members…</p>
        {:else if hasNextPage}
          <p class={note}>Scroll to explore more campaign members.</p>
        {/if}
      {/snippet}
    </CampaignVirtualList>
  </div>
</section>
