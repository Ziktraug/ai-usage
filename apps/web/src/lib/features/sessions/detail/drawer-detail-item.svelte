<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const detailLabelRow = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
  });
  const detailInfoButton = css({
    display: 'inline-grid',
    placeItems: 'center',
    w: '44px',
    h: '44px',
    m: '-14px -12px -14px 0',
    p: 0,
    border: 0,
    bg: 'transparent',
    color: 'muted',
    cursor: 'help',
    '&:hover > [data-detail-hint-glyph]': { borderColor: 'lineStrong', color: 'ink' },
    '&:focus-visible': { outline: 'none' },
    '&:focus-visible > [data-detail-hint-glyph]': {
      outline: '2px solid token(colors.accent)',
      outlineOffset: '2px',
    },
  });
  const detailHintContent = css({
    maxW: '320px',
    color: 'ink',
    fontSize: '13px',
    lineHeight: 1.5,
  });
  const detailItem = css({ display: 'grid', gap: '5px', minW: 0 });
  const detailLabel = css({ textStyle: 'label', color: 'muted' });
  const detailValue = css({
    textStyle: 'numeric',
    fontSize: '13px',
    fontWeight: 500,
    overflowWrap: 'anywhere',
  });
  const popoverContent = css({
    zIndex: 70,
    display: 'grid',
    gap: '10px',
    w: 'min(560px, calc(100vw - 32px))',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'overlay',
  });
</script>

<script lang="ts">
  import { Popover, provenanceMarkerClass } from '@ai-usage/design-system/svelte';
  import { onDestroy } from 'svelte';

  let {
    hint,
    hintDisabled = false,
    label,
    onHintSettled,
    openHint,
    onHintOpenChange,
    value,
  }: {
    hint?: string;
    hintDisabled?: boolean;
    label: string;
    onHintSettled?: (hintId: symbol) => void;
    openHint?: symbol | null;
    onHintOpenChange?: (hintId: symbol, open: boolean) => void;
    value: string;
  } = $props();

  const hintId = Symbol('session-drawer-detail-hint');
  onDestroy(() => onHintSettled?.(hintId));
</script>

<div class={detailItem} data-detail-item={label}>
  <div class={detailLabelRow}>
    <div class={detailLabel}>{label}</div>
    {#if hint}
      <Popover
        contentAriaLabel={`About ${label}`}
        contentClass={popoverContent}
        onExitComplete={() => onHintSettled?.(hintId)}
        onOpenChange={(open) => onHintOpenChange?.(hintId, open)}
        open={openHint === undefined ? undefined : openHint === hintId}
        triggerAriaLabel={`About ${label}`}
        triggerClass={detailInfoButton}
        triggerDisabled={hintDisabled}
        triggerTitle={`About ${label}`}
      >
        {#snippet trigger()}
          <span aria-hidden="true" class={provenanceMarkerClass} data-detail-hint-glyph>i</span>
        {/snippet}
        <div class={detailHintContent}>{hint}</div>
      </Popover>
    {/if}
  </div>
  <div class={detailValue}>{value}</div>
</div>
