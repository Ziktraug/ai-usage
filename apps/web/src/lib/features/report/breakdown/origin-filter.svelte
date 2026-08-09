<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import Checkbox from '@ai-usage/design-system/svelte/checkbox';
  import Popover from '@ai-usage/design-system/svelte/popover';
  import { type SessionOrigin, sessionOriginLabel, sessionOrigins } from '@ai-usage/report-core/session-query';
  import { defaultDashboardOrigins, isDefaultDashboardOriginSelection } from '../../../../dashboard-search';
  import { button, field } from './styles';

  // Composed from the shared field so Origin keeps the same height, border and padding as the
  // harness and machine selects beside it — on its own it rendered as borderless tinted text.
  // The accent treatment is additive and now means one thing only: this filter is narrowing.
  const originTrigger = cx(
    field,
    css({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      minW: { base: 0, sm: '190px' },
      flex: { base: '1 1 190px', sm: '0 1 220px' },
      cursor: 'pointer',
      textAlign: 'left',
      _hover: { borderColor: 'lineStrong' },
    }),
  );
  const narrowedOriginTrigger = css({ borderColor: 'accent', bg: 'accentTint' });
  const popoverContent = css({
    zIndex: 50,
    display: 'grid',
    gap: '10px',
    w: 'min(560px, calc(100vw - 32px))',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'overlay',
  });
  const popoverHeader = css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '8px',
    color: 'muted',
    fontSize: '12px',
  });
  const popoverGrid = css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: '6px',
  });

  let { onValueChange, value }: { onValueChange: (origins: SessionOrigin[]) => void; value: SessionOrigin[] } =
    $props();
  const normalized = $derived(value.length === 0 ? sessionOrigins : value);
  const label = $derived.by(() => {
    if (isDefaultDashboardOriginSelection(value)) {
      return 'Origin: all';
    }
    const selected = new Set(value);
    const excluded = sessionOrigins.filter((origin) => !selected.has(origin));
    return `Origin: excluding ${excluded.map((origin) => sessionOriginLabel(origin).toLowerCase()).join(' + ')}`;
  });
  const setChecked = (origin: SessionOrigin, checked: boolean): void => {
    const next = new Set(normalized);
    if (checked) {
      next.add(origin);
    } else {
      next.delete(origin);
    }
    const selection = sessionOrigins.filter((candidate) => next.has(candidate));
    onValueChange(selection.length === sessionOrigins.length ? [] : selection);
  };
</script>

{#snippet trigger()}
  <span>{label} ▾</span>
{/snippet}

<Popover
  contentClass={popoverContent}
  {trigger}
  triggerAriaLabel="Filter by origin"
  triggerClass={value.length > 0 ? cx(originTrigger, narrowedOriginTrigger) : originTrigger}
>
  <div class={popoverHeader}>
    <span>Session origin</span>
    <div>
      <button class={button} onclick={() => onValueChange([...defaultDashboardOrigins])} type="button">Default</button>
      <button class={button} onclick={() => onValueChange([])} type="button">All</button>
    </div>
  </div>
  <div class={popoverGrid}>
    {#each sessionOrigins as origin (origin)}
      <Checkbox checked={normalized.includes(origin)} onCheckedChange={(checked) => setChecked(origin, checked)}>
        {sessionOriginLabel(origin)}
      </Checkbox>
    {/each}
  </div>
</Popover>
