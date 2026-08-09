<script lang="ts" module>
  export interface SegmentedControlItem {
    label: string;
    value: string;
  }

  export interface SegmentedControlProps {
    ariaLabel: string;
    defaultValue?: string;
    items: readonly SegmentedControlItem[];
    label?: string;
    onValueChange: (value: string) => void;
    value: string;
  }
</script>

<script lang="ts">
  import { ToggleGroup } from '@ark-ui/svelte/toggle-group';
  import { presetButton } from '../../components/button';
  import { presetGroup, presetGroupLabel, presetGroupShell } from '../../components/time-slider';
  import { nextSegmentValue } from './segmented-control';

  let { ariaLabel, defaultValue, items, label, onValueChange, value }: SegmentedControlProps = $props();
</script>

<div class={presetGroupShell}>
  {#if label}
    <span class={presetGroupLabel}>{label}</span>
  {/if}
  <ToggleGroup.Root
    aria-label={ariaLabel}
    class={presetGroup}
    deselectable={false}
    onValueChange={(details) => {
      const nextValue = nextSegmentValue(details.value);
      if (nextValue) {
        onValueChange(nextValue);
      }
    }}
    orientation="horizontal"
    rovingFocus
    value={[value]}
  >
    {#each items as item (item.value)}
      <ToggleGroup.Item class={presetButton} data-default={String(item.value === defaultValue)} value={item.value}>
        {item.label}
      </ToggleGroup.Item>
    {/each}
  </ToggleGroup.Root>
</div>
