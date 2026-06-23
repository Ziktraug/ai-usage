import { ToggleGroup } from '@ark-ui/solid/toggle-group';
import { For } from 'solid-js';
import { presetButton } from './button';
import { presetGroup, presetGroupLabel, presetGroupShell } from './time-slider';

export interface SegmentedControlItem {
  label: string;
  value: string;
}

export interface SegmentedControlProps {
  ariaLabel: string;
  items: readonly SegmentedControlItem[];
  label?: string;
  onValueChange: (value: string) => void;
  value: string;
}

export const SegmentedControl = (props: SegmentedControlProps) => (
  <div class={presetGroupShell}>
    {props.label ? <span class={presetGroupLabel}>{props.label}</span> : null}
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
  </div>
);
