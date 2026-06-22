import { css } from '@ai-usage/design-system/css';
import { Checkbox as ArkCheckbox } from '@ark-ui/solid/checkbox';
import type { JSX } from 'solid-js';

export interface CheckboxProps {
  checked: boolean;
  children: JSX.Element;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const columnToggle = css({
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
  _hover: {
    bg: 'surfaceMuted',
    borderColor: 'lineStrong',
  },
  '&[data-disabled]': {
    color: 'faint',
    cursor: 'not-allowed',
  },
});

export const columnToggleInput = css({
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
  '&[data-state=checked]': {
    bg: 'accent',
    borderColor: 'accent',
  },
});

export const columnToggleText = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const Checkbox = (props: CheckboxProps) => (
  <ArkCheckbox.Root
    checked={props.checked}
    class={columnToggle}
    disabled={props.disabled}
    onCheckedChange={(details) => props.onCheckedChange(details.checked === true)}
  >
    <ArkCheckbox.HiddenInput />
    <ArkCheckbox.Control class={columnToggleInput}>
      <ArkCheckbox.Indicator>✓</ArkCheckbox.Indicator>
    </ArkCheckbox.Control>
    <ArkCheckbox.Label class={columnToggleText}>{props.children}</ArkCheckbox.Label>
  </ArkCheckbox.Root>
);
