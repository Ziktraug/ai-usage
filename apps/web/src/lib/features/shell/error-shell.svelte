<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import {
    commandButton,
    header,
    meta,
    page,
    panel,
    panelSub,
    panelTitle,
    shell,
    title,
    titleBlock,
  } from '@ai-usage/design-system/svelte';

  let {
    message = 'Report data could not be loaded.',
    onRetry,
    pending = false,
    status,
  }: {
    message?: string | undefined;
    onRetry?: () => Promise<void> | void;
    pending?: boolean;
    status: number;
  } = $props();

  const statusPanel = css({ display: 'grid', gap: '12px', maxW: '640px' });
</script>

{#if status === 404}
  <main class={page}>
    <div class={shell}>
      <h1 class={title}>Not Found</h1>
      <a class={commandButton} href="/">Return to report</a>
    </div>
  </main>
{:else}
  <main class={page} data-hydrated="false">
    <div class={shell}>
      <header class={header}>
        <div class={titleBlock}>
          <p class={meta}>ai-usage</p>
          <h1 class={title}>Usage report</h1>
        </div>
      </header>
      <section aria-live="polite" class={`${panel} ${statusPanel}`}>
        <h2 class={panelTitle}>Report unavailable</h2>
        <p class={panelSub}>{message}</p>
        {#if onRetry}
          <button class={commandButton} disabled={pending} onclick={onRetry} type="button">
            {pending ? 'Retrying…' : 'Retry'}
          </button>
        {/if}
      </section>
    </div>
  </main>
{/if}
