import { css } from '@ai-usage/design-system/css';
import { Popover as ArkPopover } from '@ark-ui/solid/popover';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

export interface PopoverProps {
  children: JSX.Element;
  contentClass?: string;
  trigger: JSX.Element;
  triggerAriaLabel?: string;
  triggerClass?: string;
}

const popoverPositioner = css({ zIndex: 50 });

export const Popover = (props: PopoverProps) => (
  <ArkPopover.Root lazyMount positioning={{ gutter: 4 }} unmountOnExit>
    <ArkPopover.Trigger aria-label={props.triggerAriaLabel} class={props.triggerClass}>
      {props.trigger}
    </ArkPopover.Trigger>
    <Portal>
      <ArkPopover.Positioner class={popoverPositioner}>
        <ArkPopover.Content class={props.contentClass ?? popoverContent}>{props.children}</ArkPopover.Content>
      </ArkPopover.Positioner>
    </Portal>
  </ArkPopover.Root>
);

export const popoverContent = css({
  zIndex: 50,
  display: 'grid',
  gap: '10px',
  w: 'min(560px, calc(100vw - 32px))',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'overlay',
  animation: 'fadeIn 0.12s ease-out',
});

export const popoverHeader = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
  color: 'muted',
  fontSize: '12px',
});

export const popoverGrid = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: '6px',
});
