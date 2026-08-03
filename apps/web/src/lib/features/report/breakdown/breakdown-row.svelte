<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import type { BreakdownRowView } from './model';
  import { barFill, barTrack, identityButton, metric, muted, partialBarTrack } from './styles';

  let {
    child = false,
    controlsId,
    expanded = false,
    onFilter,
    onToggle,
    view,
  }: {
    child?: boolean;
    controlsId?: string;
    expanded?: boolean;
    onFilter: () => void;
    onToggle?: () => void;
    view: BreakdownRowView;
  } = $props();

  const content = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '12px',
    alignItems: 'center',
  });
  const nested = css({ pl: { base: '48px', md: '56px' }, bg: 'surfaceMuted' });
  const identity = css({ display: 'flex', alignItems: 'center', gap: '8px', minW: 0 });
  const expandedAria = (value: boolean): { readonly 'aria-expanded': 'false' | 'true' } => ({
    'aria-expanded': value ? 'true' : 'false',
  });
  const toggle = css({
    appearance: 'none',
    display: 'inline-grid',
    placeItems: 'center',
    minH: '32px',
    minW: '32px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'transparent',
    color: 'muted',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const pricedShareHint =
    'Share of the known API-value subtotal in this breakdown; ≥ values include lower bounds from incomplete pricing';
</script>

<div
  class={cx(content, child ? nested : undefined)}
  data-price-state={view.priceState}
  data-provider-child={child ? view.group.provider : undefined}
>
  <div>
    <div class={identity}>
      {#if onToggle && controlsId}
        <button
          aria-controls={controlsId}
          {...expandedAria(expanded)}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} providers for ${view.group.harness}`}
          class={toggle}
          onclick={onToggle}
          type="button"
        >
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      {/if}
      <button class={identityButton} onclick={onFilter} type="button">{view.label}</button>
    </div>
    <div class={muted} title={view.freshTitle}>
      {view.sessionSummary}
      · {view.freshLabel} · {view.cacheLabel}{view.pricingCoverage}
    </div>
    {#if view.widthPercent !== null}
      <div
        aria-label={view.ariaLabel}
        class={cx(barTrack, view.priceState === 'partially measured' ? partialBarTrack : undefined)}
        data-price-bar={view.priceState}
        data-width-percent={String(view.widthPercent)}
        role="img"
      >
        <div class={barFill} style:width={`${view.widthPercent}%`}></div>
      </div>
    {/if}
  </div>
  <div class={metric}>
    <strong title={view.valueTitle}>{view.valueLabel}</strong>
    <div class={muted} title={pricedShareHint}>{view.group.costPercent.toFixed(1)}%</div>
  </div>
</div>
