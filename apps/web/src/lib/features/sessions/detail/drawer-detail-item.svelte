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
    w: '24px',
    h: '24px',
    p: 0,
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    bg: 'surfaceMuted',
    color: 'muted',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
    _hover: { borderColor: 'lineStrong', color: 'ink' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
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
  import { Popover } from '@ai-usage/design-system/svelte';

  let {
    hint,
    label,
    onHintExitComplete,
    openHint,
    onHintOpenChange,
    value,
  }: {
    hint?: string;
    label: string;
    onHintExitComplete?: (label: string) => void;
    openHint?: string | null;
    onHintOpenChange?: (label: string, open: boolean) => void;
    value: string;
  } = $props();
</script>

<div class={detailItem} data-detail-item={label}>
  <div class={detailLabelRow}>
    <div class={detailLabel}>{label}</div>
    {#if hint}
      <Popover
        contentClass={popoverContent}
        onExitComplete={() => onHintExitComplete?.(label)}
        onOpenChange={(open) => onHintOpenChange?.(label, open)}
        open={openHint === undefined ? undefined : openHint === label}
        triggerAriaLabel={`About ${label}`}
        triggerClass={detailInfoButton}
        triggerTitle={`About ${label}`}
      >
        {#snippet trigger()}
          <span aria-hidden="true">i</span>
        {/snippet}
        <div class={detailHintContent}>{hint}</div>
      </Popover>
    {/if}
  </div>
  <div class={detailValue}>{value}</div>
</div>
