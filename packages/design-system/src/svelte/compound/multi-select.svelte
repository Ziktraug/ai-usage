<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';

  const selectRoot = css({
    display: 'inline-flex',
    flexDirection: 'column',
    flex: { base: '1 1 120px', sm: '0 1 180px' },
    minW: { base: 0, sm: '150px' },
  });

  const selectControl = css({ display: 'flex', w: 'full' });

  const selectTrigger = cx(
    css({
      w: '100%',
      minW: 0,
      h: '36px',
      px: '10px',
      border: '1px solid token(colors.lineStrong)',
      borderRadius: 'sm',
      bg: 'surface',
      color: 'ink',
      fontSize: '13px',
      _focusVisible: {
        outline: '2px solid token(colors.accent)',
        outlineOffset: '2px',
      },
    }),
    css({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      cursor: 'pointer',
      textAlign: 'left',
      _hover: { borderColor: 'lineStrong' },
      '&[data-state=open]': {
        borderColor: 'accent',
        boxShadow: '0 0 0 3px token(colors.focusRing)',
      },
    }),
  );

  const selectTriggerText = css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const selectTriggerPlaceholder = css({ color: 'muted' });
  const selectIndicator = css({
    flexShrink: 0,
    color: 'faint',
    fontSize: '10px',
    transition: 'transform 0.15s',
    '[data-state=open] &': { transform: 'rotate(180deg)' },
  });

  // Zag owns an inline --z-index:auto on the positioner. The important value
  // is required to keep the menu above the sticky toolbar (z-index 20).
  const selectPositioner = css({ zIndex: '50 !important' });
  const selectContent = css({
    display: 'grid',
    gap: '2px',
    w: 'full',
    maxH: '320px',
    overflowY: 'auto',
    p: '6px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: '0 12px 32px -10px rgba(0, 0, 0, 0.45)',
    animation: 'fadeIn 0.12s ease-out',
    _focusVisible: { outline: 'none' },
  });
  const selectItem = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    minH: '32px',
    px: '10px',
    borderRadius: 'sm',
    fontSize: '13px',
    color: 'ink',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'background-color 0.12s',
    '&[data-state=checked]': { bg: 'accentTint' },
    '&[data-highlighted]': { bg: 'surfaceMuted' },
  });
  const selectItemIndicator = css({ flexShrink: 0, color: 'accent', fontSize: '12px' });

  export interface MultiSelectProps {
    label: string;
    name?: string;
    noun: string;
    onValueChange: (value: string[]) => void;
    optionLabel?: (value: string) => string;
    options: string[];
    placeholder: string;
    value: string[];
  }
</script>

<script lang="ts">
  import { createListCollection } from '@ark-ui/svelte/collection';
  import { Portal } from '@ark-ui/svelte/portal';
  import { Select } from '@ark-ui/svelte/select';
  import { multiSelectSummary } from './multi-select';

  let {
    label,
    name,
    noun,
    onValueChange,
    optionLabel: labelForOption,
    options,
    placeholder,
    value,
  }: MultiSelectProps = $props();

  const optionLabel = (option: string): string => labelForOption?.(option) ?? option;
  const collection = $derived(
    createListCollection({
      items: options,
      itemToString: optionLabel,
      itemToValue: (item) => item,
    }),
  );
  const triggerLabel = $derived(multiSelectSummary(value, placeholder, noun, optionLabel));
</script>

<Select.Root
  class={selectRoot}
  closeOnSelect={false}
  {collection}
  multiple
  {name}
  onValueChange={(details) => onValueChange(details.value)}
  positioning={{ sameWidth: true, gutter: 4 }}
  {value}
>
  <Select.HiddenSelect />
  <Select.Control class={selectControl}>
    <Select.Trigger aria-label={label} class={selectTrigger}>
      <span class={cx(selectTriggerText, value.length === 0 ? selectTriggerPlaceholder : undefined)}>
        {triggerLabel}
      </span>
      <Select.Indicator class={selectIndicator}>▾</Select.Indicator>
    </Select.Trigger>
  </Select.Control>
  <Portal>
    <Select.Positioner class={selectPositioner}>
      <Select.Content class={selectContent}>
        {#each options as option (option)}
          <Select.Item class={selectItem} item={option}>
            <Select.ItemText>{optionLabel(option)}</Select.ItemText>
            <Select.ItemIndicator class={selectItemIndicator}>✓</Select.ItemIndicator>
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Positioner>
  </Portal>
</Select.Root>
