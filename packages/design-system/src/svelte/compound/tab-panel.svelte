<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export interface TabPanelProps {
    class: string;
    content: Snippet;
    value: string;
  }
</script>

<script lang="ts">
  import { Tabs } from '@ark-ui/svelte/tabs';
  import { keepTabPanelInTabOrder } from './tab-panel';

  let { class: className, content, value }: TabPanelProps = $props();
  let panel: HTMLElement | null = $state(null);

  $effect(() => {
    const element = panel;
    if (!element) {
      return;
    }
    keepTabPanelInTabOrder(element, (callback) => {
      element.ownerDocument.defaultView?.requestAnimationFrame(callback);
    });
  });
</script>

<Tabs.Content class={className} tabindex={0} {value} bind:ref={panel}> {@render content()} </Tabs.Content>
