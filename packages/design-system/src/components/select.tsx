import { css, cx } from '@ai-usage/design-system/css';
import { createListCollection, Select } from '@ark-ui/solid/select';
import { createMemo, For } from 'solid-js';
import { Portal } from 'solid-js/web';
import { field } from './field';

const selectRoot = css({
  display: 'inline-flex',
  flexDirection: 'column',
  flex: '0 1 180px',
  minW: '150px',
});

const selectControl = css({ display: 'flex', w: 'full' });

const selectTrigger = cx(
  field,
  css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    w: 'full',
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

// Zag sets `z-index: var(--z-index)` with `--z-index: auto` inline on the
// positioner, so neither a `z-index` nor a `--z-index` class can win against
// it. `!important` is the only override that beats a non-important inline
// declaration — without it the menu renders below the sticky toolbar
// (z-index 20) and its top edge is clipped.
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
  /** Accessible label for the trigger. */
  label: string;
  /** Plural noun shown when more than one option is selected (e.g. "machines"). */
  noun: string;
  onValueChange: (value: string[]) => void;
  options: string[];
  /** Shown when nothing is selected (e.g. "All machines"). */
  placeholder: string;
  value: string[];
}

export const MultiSelect = (props: MultiSelectProps) => {
  const collection = createMemo(() =>
    createListCollection({
      items: props.options,
      itemToValue: (item) => item,
      itemToString: (item) => item,
    }),
  );
  const triggerLabel = createMemo(() => {
    const count = props.value.length;
    if (count === 0) {
      return props.placeholder;
    }
    if (count === 1) {
      return props.value[0];
    }
    return `${count} ${props.noun}`;
  });

  return (
    <Select.Root
      class={selectRoot}
      closeOnSelect={false}
      collection={collection()}
      multiple
      onValueChange={(details) => props.onValueChange(details.value)}
      positioning={{ sameWidth: true, gutter: 4 }}
      value={props.value}
    >
      <Select.Control class={selectControl}>
        <Select.Trigger aria-label={props.label} class={selectTrigger}>
          <span class={cx(selectTriggerText, props.value.length === 0 ? selectTriggerPlaceholder : undefined)}>
            {triggerLabel()}
          </span>
          <Select.Indicator class={selectIndicator}>▾</Select.Indicator>
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner class={selectPositioner}>
          <Select.Content class={selectContent}>
            <For each={props.options}>
              {(option) => (
                <Select.Item class={selectItem} item={option}>
                  <Select.ItemText>{option}</Select.ItemText>
                  <Select.ItemIndicator class={selectItemIndicator}>✓</Select.ItemIndicator>
                </Select.Item>
              )}
            </For>
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
};
