<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { banner, bannerError, bannerOk } from '@ai-usage/design-system/svelte';
  import type { DelegationSaveOutcome } from './delegation-contract';
  import { conflictText } from './delegation-model';
  import { compactList, noticeStack, workButton } from './delegation-styles';

  let {
    onReload,
    outcome,
    pending,
  }: {
    onReload: () => Promise<void>;
    outcome: DelegationSaveOutcome | null;
    pending: boolean;
  } = $props();
</script>

<div class={noticeStack} data-delegation-save-notice>
  {#if pending}
    <p aria-live="polite" class={banner} role="status">Saving…</p>
  {:else if outcome?.kind === 'written'}
    <p aria-live="polite" class={cx(banner, bannerOk)} role="status">
      Saved. The configuration is now at revision {outcome.revision}.
    </p>
  {:else if outcome?.kind === 'conflict'}
    <div class={cx(banner, bannerError)} data-delegation-conflict role="alert">
      <p>{conflictText(outcome.revision)}</p>
      <button class={workButton} onclick={onReload} type="button">Reload settings</button>
    </div>
  {:else if outcome?.kind === 'invalid'}
    <div class={cx(banner, bannerError)} role="alert">
      <p>{outcome.message}</p>
      {#if outcome.issues.length > 0}
        <ul class={compactList}>
          {#each outcome.issues as issue, index (`${issue.path}:${index}`)}
            <li><code>{issue.path}</code>: {issue.reason}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if outcome?.kind === 'unavailable'}
    <p class={cx(banner, bannerError)} role="alert">{outcome.message} ({outcome.tag})</p>
  {/if}
</div>
