import { css } from '@ai-usage/design-system/css';
import { Tabs as ArkTabs } from '@ark-ui/solid/tabs';
import { For, type JSX } from 'solid-js';

export interface TabItem {
  content: () => JSX.Element;
  disabled?: boolean;
  label: string;
  value: string;
}

export interface TabsProps {
  ariaLabel: string;
  items: readonly TabItem[];
  onValueChange: (value: string) => void;
  value: string;
}

export const tabsRoot = css({
  display: 'grid',
  gap: '16px',
});

export const tabsList = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0 20px',
  borderBottom: '1px solid token(colors.line)',
});

export const tabTrigger = css({
  appearance: 'none',
  border: '0',
  borderBottom: '2px solid transparent',
  mb: '-1px',
  bg: 'transparent',
  color: 'muted',
  px: '2px',
  py: '10px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'color 0.15s, border-color 0.15s',
  _hover: {
    color: 'ink',
  },
  '&[data-selected]': {
    color: 'ink',
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
});

export const tabContent = css({
  minW: 0,
  _focus: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '4px',
  },
});

const keepTabPanelInTabOrder = (element: HTMLDivElement): void => {
  element.tabIndex = 0;
  // Zag removes tabindex in its next animation frame when a panel already
  // contains focusable controls. This component intentionally keeps the active
  // panel itself keyboard-reachable, so reassert the shared accessibility
  // contract after that synchronization.
  element.ownerDocument.defaultView?.requestAnimationFrame(() => {
    if (element.isConnected) {
      element.tabIndex = 0;
    }
  });
};

export const Tabs = (props: TabsProps) => (
  <ArkTabs.Root
    class={tabsRoot}
    composite
    lazyMount
    onValueChange={(details) => props.onValueChange(details.value)}
    unmountOnExit
    value={props.value}
  >
    <ArkTabs.List aria-label={props.ariaLabel} class={tabsList}>
      <For each={props.items}>
        {(item) => (
          <ArkTabs.Trigger class={tabTrigger} disabled={item.disabled} value={item.value}>
            {item.label}
          </ArkTabs.Trigger>
        )}
      </For>
    </ArkTabs.List>
    <For each={props.items}>
      {(item) => (
        <ArkTabs.Content class={tabContent} ref={keepTabPanelInTabOrder} tabIndex={0} value={item.value}>
          {item.content()}
        </ArkTabs.Content>
      )}
    </For>
  </ArkTabs.Root>
);
