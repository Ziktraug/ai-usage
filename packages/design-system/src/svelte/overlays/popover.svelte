<script lang="ts">
  import { Popover, type PopoverOpenChangeDetails, type PopoverRootProps } from '@ark-ui/svelte/popover';
  import { Portal } from '@ark-ui/svelte/portal';
  import type { Snippet } from 'svelte';
  import { popoverContentClass, popoverPositionerClass } from './styles';

  interface Props {
    children: Snippet;
    contentAriaLabel: string;
    contentClass?: string;
    onExitComplete?: (() => void) | undefined;
    onOpenChange?: (open: boolean) => void;
    open?: boolean | undefined;
    positioning?: PopoverRootProps['positioning'];
    trigger: Snippet;
    triggerAriaLabel?: string;
    triggerClass?: string;
    triggerDisabled?: boolean;
    triggerTitle?: string;
  }

  let {
    children,
    contentAriaLabel,
    contentClass,
    onExitComplete,
    onOpenChange,
    open,
    positioning = { gutter: 4 },
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

<Popover.Root lazyMount {onExitComplete} onOpenChange={handleOpenChange} {open} {positioning} unmountOnExit>
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
      <Popover.Content aria-label={contentAriaLabel} class={contentClass ?? popoverContentClass}>
        {@render children()}
      </Popover.Content>
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
