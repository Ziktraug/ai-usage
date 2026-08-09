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
  } from '@ai-usage/design-system/svelte/passive';

  let {
    message = 'Report data could not be loaded.',
    onRetry,
    pending = false,
    retryHref,
    retryParameters = [],
    status,
  }: {
    message?: string | undefined;
    onRetry?: () => Promise<void> | void;
    pending?: boolean;
    retryHref?: string;
    retryParameters?: readonly (readonly [string, string])[];
    status: number;
  } = $props();

  const retryForm = css({ m: 0 });
  const statusPanel = css({ display: 'grid', gap: '12px', maxW: '640px' });
  const submitRetry = async (event: SubmitEvent): Promise<void> => {
    if (!onRetry) {
      return;
    }
    event.preventDefault();
    await onRetry();
  };
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
          <form action={retryHref} class={retryForm} method="get" onsubmit={submitRetry}>
            {#each retryParameters as [ name, value ], index (`${index}:${name}:${value}`)}
              <input {name} type="hidden" {value}>
            {/each}
            <button class={commandButton} disabled={pending} type="submit">
              {pending ? 'Retrying…' : 'Retry'}
            </button>
          </form>
        {/if}
      </section>
    </div>
  </main>
{/if}
