<script lang="ts">
  import { Portal } from '@ark-ui/svelte/portal';
  import { Tooltip, type TooltipTriggerProps } from '@ark-ui/svelte/tooltip';
  import type { Snippet } from 'svelte';
  import { tooltipContentClass } from './styles';

  type _TriggerProps = Parameters<NonNullable<TooltipTriggerProps['asChild']>>[0];

  interface Props {
    children: Snippet;
    content: Snippet | string;
    contentClass?: string;
    openDelay?: number;
  }

  let { children, content, contentClass, openDelay = 300 }: Props = $props();
</script>

{#snippet triggerElement(_triggerProps: _TriggerProps)}
  <span {..._triggerProps()}> {@render children()} </span>
{/snippet}

<Tooltip.Root lazyMount {openDelay} unmountOnExit>
  <Tooltip.Trigger asChild={triggerElement} />
  <Portal>
    <Tooltip.Positioner>
      <Tooltip.Content class={contentClass ?? tooltipContentClass}>
        {#if typeof content === 'string'}
          {content}
        {:else}
          {@render content()}
        {/if}
      </Tooltip.Content>
    </Tooltip.Positioner>
  </Portal>
</Tooltip.Root>

<style>
  @media (prefers-reduced-motion: reduce) {
    :global([data-scope="tooltip"][data-part="content"]) {
      animation: none !important;
    }
  }
</style>
