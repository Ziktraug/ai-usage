<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import { field } from './styles';

  const filterTrigger = cx(
    field,
    css({
      alignItems: 'center',
      cursor: 'pointer',
      display: 'inline-flex',
      flex: { base: '1 1 120px', sm: '0 1 170px', xl: '0 1 140px' },
      gap: '8px',
      justifyContent: 'space-between',
      minW: { base: 0, sm: '140px', xl: '120px' },
      textAlign: 'left',
      _hover: { borderColor: 'lineStrong' },
      '&[data-state=open]': { borderColor: 'accent', boxShadow: '0 0 0 3px token(colors.focusRing)' },
    }),
  );
  const narrowedFilterTrigger = css({ bg: 'accentTint', borderColor: 'accent' });
  const triggerText = css({ minW: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  const triggerIndicator = css({ color: 'faint', flexShrink: 0, fontSize: '10px' });
  const filterContent = css({
    bg: 'surface',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    boxShadow: 'overlay',
    display: 'grid',
    gap: '2px',
    maxH: '360px',
    maxW: 'min(480px, calc(100vw - 16px))',
    minW: 'var(--reference-width)',
    overflowY: 'auto',
    p: '6px',
    w: 'max-content',
    zIndex: 50,
  });
  const filterHeader = css({
    alignItems: 'center',
    color: 'muted',
    display: 'flex',
    fontSize: '12px',
    gap: '12px',
    justifyContent: 'space-between',
    px: '10px',
    py: '4px',
  });
  const filterTitle = css({ color: 'ink', fontWeight: 700 });
  const optionList = css({
    display: 'grid',
    gap: '4px',
    listStyle: 'none',
    m: 0,
    minW: 0,
    p: 0,
    '& [data-scope=checkbox][data-part=root]': {
      maxW: 'none',
      w: 'full',
      borderColor: 'transparent',
      bg: 'transparent',
      _hover: { bg: 'surfaceMuted' },
    },
    '& [data-scope=checkbox][data-part=label]': {
      overflow: 'visible',
      textOverflow: 'clip',
      whiteSpace: 'nowrap',
    },
  });
  const optionLabel = css({
    display: 'block',
    minW: 0,
    whiteSpace: 'nowrap',
  });
  const allRow = css({
    appearance: 'none',
    alignItems: 'center',
    bg: 'transparent',
    border: 0,
    borderRadius: 'sm',
    color: 'ink',
    cursor: 'pointer',
    display: 'grid',
    font: 'inherit',
    fontSize: '12px',
    gap: '6px',
    gridTemplateColumns: '14px minmax(0, max-content)',
    minH: { base: '44px', sm: '28px' },
    px: '8px',
    textAlign: 'left',
    w: 'full',
    _hover: { bg: 'surfaceMuted' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
    '&[aria-pressed=true]': { bg: 'accentTint' },
  });
  const allRowBox = css({
    alignItems: 'center',
    bg: 'surface',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'xs',
    color: 'canvas',
    display: 'inline-flex',
    fontSize: '10px',
    h: '14px',
    justifyContent: 'center',
    w: '14px',
    '[aria-pressed=true] &': { bg: 'accent', borderColor: 'accent' },
  });

  export interface CheckboxFilterProps {
    label: string;
    noun: string;
    onValueChange: (value: string[]) => void;
    optionLabel?: (value: string) => string;
    options: string[];
    placeholder: string;
    summary?: (value: readonly string[]) => string;
    title: string;
    value: string[];
  }
</script>

<script lang="ts">
  import { Checkbox, Popover } from '@ai-usage/design-system/svelte';
  import { checkboxFilterIncludedCount, checkboxFilterSummary, toggleCheckboxFilterOption } from './checkbox-filter';

  let {
    label,
    noun,
    onValueChange,
    optionLabel: labelForOption,
    options,
    placeholder,
    summary,
    title,
    value,
  }: CheckboxFilterProps = $props();

  const labelFor = (option: string): string => labelForOption?.(option) ?? option;
  const allSelected = $derived(value.length === 0);
  const triggerLabel = $derived(summary?.(value) ?? checkboxFilterSummary(value, placeholder, noun, labelFor));
  const includedCount = $derived(checkboxFilterIncludedCount(value, options));
  const pressedAria = (pressed: boolean) =>
    pressed ? ({ 'aria-pressed': 'true' } as const) : ({ 'aria-pressed': 'false' } as const);
</script>

{#snippet trigger()}
  <span class={triggerText}>{triggerLabel}</span>
  <span aria-hidden="true" class={triggerIndicator}>▾</span>
{/snippet}

{#snippet allOptionContent()}
  <span aria-hidden="true" class={allRowBox}>{allSelected ? '✓' : ''}</span>
  <span class={optionLabel}>{placeholder}</span>
{/snippet}

<Popover
  contentAriaLabel={title}
  contentClass={filterContent}
  positioning={{ gutter: 4, placement: 'bottom-start' }}
  {trigger}
  triggerAriaLabel={label}
  triggerClass={value.length > 0 ? cx(filterTrigger, narrowedFilterTrigger) : filterTrigger}
  triggerTitle={triggerLabel}
>
  <div class={filterHeader}>
    <span class={filterTitle}>{title}</span>
    <span>{includedCount} of {options.length}</span>
  </div>
  <ul class={optionList}>
    <li>
      <button {...pressedAria(allSelected)} class={allRow} onclick={() => onValueChange([])} type="button">
        {@render allOptionContent()}
      </button>
    </li>
    {#each options as option (option)}
      <li>
        <Checkbox
          checked={value.includes(option)}
          onCheckedChange={(checked) =>
            onValueChange(toggleCheckboxFilterOption(value, options, option, checked))}
        >
          <span class={optionLabel} title={labelFor(option)}>{labelFor(option)}</span>
        </Checkbox>
      </li>
    {/each}
  </ul>
</Popover>
