import { Toggle as ArkToggle } from '@ark-ui/solid/toggle';
import type { JSX } from 'solid-js';

export interface ToggleProps {
  ariaLabel: string;
  children: JSX.Element;
  class?: string;
  disabled?: boolean;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  onPressedChange: (pressed: boolean) => void;
  pressed: boolean;
  title?: string;
}

export const Toggle = (props: ToggleProps) => (
  <ArkToggle.Root
    aria-label={props.ariaLabel}
    class={props.class}
    disabled={props.disabled}
    onClick={props.onClick}
    onPressedChange={props.onPressedChange}
    pressed={props.pressed}
    title={props.title}
  >
    {props.children}
  </ArkToggle.Root>
);
