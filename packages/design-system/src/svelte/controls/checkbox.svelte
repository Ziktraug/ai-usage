<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';

  const columnToggle = css({
    display: 'inline-grid',
    gridTemplateColumns: '14px minmax(0, max-content)',
    gap: '6px',
    alignItems: 'center',
    maxW: '180px',
    minH: '28px',
    px: '8px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'canvas',
    color: 'ink',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'border-color 0.15s, background-color 0.15s',
    _hover: { bg: 'surfaceMuted', borderColor: 'lineStrong' },
    '&[data-disabled]': { color: 'faint', cursor: 'not-allowed' },
  });

  const columnToggleInput = css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    w: '14px',
    h: '14px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'xs',
    bg: 'surface',
    color: 'canvas',
    fontSize: '10px',
    lineHeight: 1,
    '&[data-state=checked]': { bg: 'accent', borderColor: 'accent' },
  });

  const columnToggleText = css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });

  export interface CheckboxProps {
    checked: boolean;
    children: Snippet;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }
</script>

<script lang="ts">
  import { Checkbox } from '@ark-ui/svelte/checkbox';

  let { checked, children, disabled = false, onCheckedChange }: CheckboxProps = $props();
</script>

<Checkbox.Root
  {checked}
  class={columnToggle}
  {disabled}
  onCheckedChange={(details) => onCheckedChange(details.checked === true)}
>
  <Checkbox.HiddenInput />
  <Checkbox.Control class={columnToggleInput}>
    <Checkbox.Indicator>✓</Checkbox.Indicator>
  </Checkbox.Control>
  <Checkbox.Label class={columnToggleText}>{@render children()}</Checkbox.Label>
</Checkbox.Root>
