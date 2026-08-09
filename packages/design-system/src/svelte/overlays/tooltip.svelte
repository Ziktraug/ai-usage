<script lang="ts">
  import { Portal } from '@ark-ui/svelte/portal';
  import { Tooltip, type TooltipTriggerProps } from '@ark-ui/svelte/tooltip';
  import type { Snippet } from 'svelte';
  import { tooltipContentClass } from './styles';

  type TriggerPropsGetter = Parameters<NonNullable<TooltipTriggerProps['asChild']>>[0];
  type TriggerProps = ReturnType<TriggerPropsGetter>;

  interface Props {
    content: Snippet | string;
    contentClass?: string;
    openDelay?: number;
    trigger: Snippet<[TriggerProps]>;
  }

  let { content, contentClass, openDelay = 300, trigger }: Props = $props();
</script>

{#snippet triggerElement(_getTriggerProps: TriggerPropsGetter)}
  {@render trigger(_getTriggerProps())}
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
