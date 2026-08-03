<script lang="ts">
  import { header, meta, page, shell, title, titleBlock } from '@ai-usage/design-system/svelte';
  import type { Snippet } from 'svelte';

  let { children, heading }: { children?: Snippet; heading: string } = $props();
</script>

<main class={page}>
  <div class={shell}>
    <header class={header}>
      <div class={titleBlock}>
        <p class={meta}>ai-usage</p>
        <h1 class={title}>{heading}</h1>
      </div>
    </header>
    {#if children}
      {@render children()}
    {/if}
  </div>
</main>
