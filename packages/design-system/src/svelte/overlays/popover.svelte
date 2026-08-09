<script lang="ts">
  import { Popover } from '@ark-ui/svelte/popover';
  import { Portal } from '@ark-ui/svelte/portal';
  import type { Snippet } from 'svelte';
  import { popoverContentClass, popoverPositionerClass } from './styles';

  interface Props {
    children: Snippet;
    contentClass?: string;
    trigger: Snippet;
    triggerAriaLabel?: string;
    triggerClass?: string;
    triggerTitle?: string;
  }

  let { children, contentClass, trigger, triggerAriaLabel, triggerClass, triggerTitle }: Props = $props();
</script>

<Popover.Root lazyMount positioning={{ gutter: 4 }} unmountOnExit>
  <Popover.Trigger aria-label={triggerAriaLabel} class={triggerClass} title={triggerTitle} type="button">
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
