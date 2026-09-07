<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { commandButton, page, panel, panelSub, panelTitle, shell } from '@ai-usage/design-system/svelte';
  import WorkspaceHeader from './workspace-header.svelte';

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
      <WorkspaceHeader description="This page could not be found." eyebrow="Workspace" heading="Not Found" />
      <a class={commandButton} href="/">Return to report</a>
    </div>
  </main>
{:else}
  <main class={page} data-hydrated="false">
    <div class={shell}>
      <WorkspaceHeader eyebrow="Workspace" heading="Usage report" />
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
