<script lang="ts">
  import { Popover, type PopoverOpenChangeDetails } from '@ark-ui/svelte/popover';
  import { Portal } from '@ark-ui/svelte/portal';
  import type { Snippet } from 'svelte';
  import { popoverContentClass, popoverPositionerClass } from './styles';

  interface Props {
    children: Snippet;
    contentClass?: string;
    onExitComplete?: (() => void) | undefined;
    onOpenChange?: (open: boolean) => void;
    open?: boolean | undefined;
    trigger: Snippet;
    triggerAriaLabel?: string;
    triggerClass?: string;
    triggerDisabled?: boolean;
    triggerTitle?: string;
  }

  let {
    children,
    contentClass,
    onExitComplete,
    onOpenChange,
    open,
    trigger,
    triggerAriaLabel,
    triggerClass,
    triggerDisabled,
    triggerTitle,
  }: Props = $props();

  const handleOpenChange = (details: PopoverOpenChangeDetails): void => {
    onOpenChange?.(details.open);
  };
</script>

<Popover.Root
  lazyMount
  {onExitComplete}
  onOpenChange={handleOpenChange}
  {open}
  positioning={{ gutter: 4 }}
  unmountOnExit
>
  <Popover.Trigger
    aria-label={triggerAriaLabel}
    class={triggerClass}
    disabled={triggerDisabled}
    title={triggerTitle}
    type="button"
  >
    {@render trigger()}
  </Popover.Trigger>
  <Portal>
    <Popover.Positioner class={popoverPositionerClass}>
      <Popover.Content class={contentClass ?? popoverContentClass}> {@render children()} </Popover.Content>
    </Popover.Positioner>
  </Portal>
</Popover.Root>

<style>
  @media (prefers-reduced-motion: reduce) {
    :global([data-scope="popover"][data-part="content"]) {
      animation: none !important;
    }
  }
</style>
