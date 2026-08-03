<script lang="ts">
  import { Drawer, type DrawerOpenChangeDetails } from '@ark-ui/svelte/drawer';
  import { Portal } from '@ark-ui/svelte/portal';
  import type { Snippet } from 'svelte';
  import { drawerClass } from './styles';

  interface Props {
    children: Snippet;
    closeOnInteractOutside?: boolean;
    contentAriaLabel: string;
    contentClass?: string;
    finalFocusEl?: () => HTMLElement | null;
    initialFocusEl?: () => HTMLElement | null;
    modal?: boolean;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    trapFocus?: boolean;
  }

  let {
    children,
    closeOnInteractOutside,
    contentAriaLabel,
    contentClass,
    finalFocusEl,
    initialFocusEl,
    modal,
    onOpenChange,
    open,
    trapFocus,
  }: Props = $props();
</script>

<Drawer.Root
  {closeOnInteractOutside}
  {finalFocusEl}
  {initialFocusEl}
  {modal}
  onOpenChange={(details: DrawerOpenChangeDetails) => onOpenChange(details.open)}
  {open}
  {trapFocus}
>
  <Portal>
    <Drawer.Positioner>
      <Drawer.Content aria-label={contentAriaLabel} class={contentClass ?? drawerClass}>
        {@render children()}
      </Drawer.Content>
    </Drawer.Positioner>
  </Portal>
</Drawer.Root>

<style>
  @media (prefers-reduced-motion: reduce) {
    :global([data-scope="drawer"][data-part="content"]) {
      animation: none !important;
    }
  }
</style>
