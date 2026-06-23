import { ToggleGroup } from '@ark-ui/solid/toggle-group';
import { For } from 'solid-js';
import { presetButton } from './button';
import { presetGroup } from './time-slider';

export interface SegmentedControlItem {
  label: string;
  value: string;
}

export interface SegmentedControlProps {
  ariaLabel: string;
  items: readonly SegmentedControlItem[];
  onValueChange: (value: string) => void;
  value: string;
}

export const SegmentedControl = (props: SegmentedControlProps) => (
  <ToggleGroup.Root
    aria-label={props.ariaLabel}
    class={presetGroup}
    deselectable={false}
    onValueChange={(details) => {
      const nextValue = details.value[0];
      if (nextValue) {
        props.onValueChange(nextValue);
      }
    }}
    value={[props.value]}
  >
    <For each={props.items}>
      {(item) => (
        <ToggleGroup.Item class={presetButton} value={item.value}>
          {item.label}
        </ToggleGroup.Item>
      )}
    </For>
  </ToggleGroup.Root>
);
