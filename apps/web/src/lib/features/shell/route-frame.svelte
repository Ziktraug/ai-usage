<script lang="ts">
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { Snippet } from 'svelte';
  import WorkspaceHeader from './workspace-header.svelte';

  let {
    children,
    eyebrow = 'ai-usage',
    headerActions,
    headerMeta,
    heading,
  }: {
    children?: Snippet;
    eyebrow?: string | null;
    headerActions?: Snippet;
    headerMeta?: Snippet;
    heading: string;
  } = $props();
</script>

<main class={page}>
  <div class={shell}>
    <WorkspaceHeader actions={headerActions} {eyebrow} {heading} meta={headerMeta} />
    {#if children}
      {@render children()}
    {/if}
  </div>
</main>
