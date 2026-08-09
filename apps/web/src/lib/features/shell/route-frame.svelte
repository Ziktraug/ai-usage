<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    header,
    headerActions as headerActionsStyle,
    headerTop,
    meta,
    page,
    shell,
    title,
    titleBlock,
  } from '@ai-usage/design-system/svelte/passive';
  import type { Snippet } from 'svelte';

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
  const compactTitle = css({ justifySelf: 'start' });
</script>

<main class={page}>
  <div class={shell}>
    <header class={header}>
      <div class={headerTop}>
        <div class={titleBlock}>
          {#if eyebrow}
            <p class={meta}>{eyebrow}</p>
          {/if}
          <h1 class={cx(title, eyebrow ? undefined : compactTitle)}>{heading}</h1>
          {#if headerMeta}
            {@render headerMeta()}
          {/if}
        </div>
        {#if headerActions}
          <div class={headerActionsStyle}>{@render headerActions()}</div>
        {/if}
      </div>
    </header>
    {#if children}
      {@render children()}
    {/if}
  </div>
</main>
