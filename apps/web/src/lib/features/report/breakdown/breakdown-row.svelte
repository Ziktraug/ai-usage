<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    accentFill,
    barFill,
    barTrack,
    dimensionSwatch,
    groupKeyButton,
    groupPct,
    groupRow,
    groupSub,
    groupValue,
    right,
  } from '@ai-usage/design-system/svelte/passive';
  import { fmtPct } from '../../../foundation/presentation/format';
  import type { BreakdownRowView } from './model';
  import { partialBarTrack } from './styles';

  let {
    child = false,
    controlsId,
    expanded = false,
    hierarchy = false,
    onFilter,
    onToggle,
    view,
  }: {
    child?: boolean;
    controlsId?: string;
    expanded?: boolean;
    hierarchy?: boolean;
    onFilter: () => void;
    onToggle?: () => void;
    view: BreakdownRowView;
  } = $props();

  const hierarchyRow = css({ borderBottom: '0' });
  const nested = css({
    borderTop: '1px solid token(colors.line)',
    pl: { base: '48px', md: '56px' },
    bg: 'surfaceMuted',
  });
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
    p: 0,
    bg: 'transparent',
    color: 'muted',
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const pricedShareHint =
    'Share of the known API-value subtotal in this breakdown; ≥ values include lower bounds from incomplete pricing';
  const fillFor = (rowView: BreakdownRowView) => dimensionSwatch('harness', rowView.group.harness);
</script>

<div
  class={cx(groupRow, hierarchy ? hierarchyRow : undefined, child ? nested : undefined)}
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
      <button class={groupKeyButton} onclick={onFilter} type="button">{view.label}</button>
    </div>
    <div class={groupSub} title={view.freshTitle}>
      {view.sessionSummary}
      · {view.freshLabel} · {view.cacheLabel}{view.pricingCoverage}
    </div>
    {#if view.widthPercent !== null}
      {@const fill = fillFor(view)}
      <div
        aria-label={view.ariaLabel}
        class={cx(barTrack, view.priceState === 'partially measured' ? partialBarTrack : undefined)}
        data-price-bar={view.priceState}
        data-width-percent={String(view.widthPercent)}
        role="img"
      >
        <div
          class={cx(barFill, fill.className ?? accentFill)}
          style:background={fill.style?.background}
          style:width={`${view.widthPercent}%`}
        ></div>
      </div>
    {/if}
  </div>
  <div class={right}>
    <div class={groupValue}><span title={view.valueTitle}>{view.valueLabel}</span></div>
    <div class={groupPct} title={pricedShareHint}>{fmtPct(view.group.costPercent)}</div>
  </div>
</div>
