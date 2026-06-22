import { RadioGroup } from '@ark-ui/solid/radio-group';
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
  <RadioGroup.Root
    aria-label={props.ariaLabel}
    class={presetGroup}
    onValueChange={(details) => {
      if (details.value) {
        props.onValueChange(details.value);
      }
    }}
    value={props.value}
  >
    <For each={props.items}>
      {(item) => (
        <RadioGroup.Item class={presetButton} value={item.value}>
          <RadioGroup.ItemHiddenInput />
          <RadioGroup.ItemText>{item.label}</RadioGroup.ItemText>
        </RadioGroup.Item>
      )}
    </For>
  </RadioGroup.Root>
);
