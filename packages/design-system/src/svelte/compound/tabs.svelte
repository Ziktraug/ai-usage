<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';

  const tabsRoot = css({
    display: 'grid',
    gap: '16px',
  });
  const tabsList = css({
    display: 'flex',
    // A wrapped strip leaves the shared bottom rule under the second row while the active underline
    // stays on the first, which reads as two tab bars. Below `md` keep one row and scroll it.
    flexWrap: { base: 'nowrap', md: 'wrap' },
    overflowX: { base: 'auto', md: 'visible' },
    // Room for the triggers' -1px pull, which an auto overflow context would otherwise clip.
    pb: '1px',
    gap: '0 20px',
    borderBottom: '1px solid token(colors.line)',
  });
  const tabTrigger = css({
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
    _hover: { color: 'ink' },
    '&[data-selected]': {
      color: 'ink',
      borderColor: 'accent',
    },
    _focusVisible: {
      outline: '2px solid token(colors.accent)',
      outlineOffset: '-2px',
    },
  });
  const tabContent = css({
    minW: 0,
    _focus: {
      outline: '2px solid token(colors.accent)',
      outlineOffset: '4px',
    },
  });

  export interface TabItem {
    content: Snippet;
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
</script>

<script lang="ts">
  import { Tabs } from '@ark-ui/svelte/tabs';
  import TabPanel from './tab-panel.svelte';

  let { ariaLabel, items, onValueChange, value }: TabsProps = $props();
</script>

<Tabs.Root
  class={tabsRoot}
  composite
  lazyMount
  onValueChange={(details) => onValueChange(details.value)}
  unmountOnExit
  {value}
>
  <Tabs.List aria-label={ariaLabel} class={tabsList}>
    {#each items as item (item.value)}
      <Tabs.Trigger class={tabTrigger} disabled={item.disabled} value={item.value}>
        {item.label}
      </Tabs.Trigger>
    {/each}
  </Tabs.List>
  {#each items as item (item.value)}
    <TabPanel class={tabContent} content={item.content} value={item.value} />
  {/each}
</Tabs.Root>
