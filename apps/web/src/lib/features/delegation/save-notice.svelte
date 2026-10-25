<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { banner, bannerError, bannerOk } from '@ai-usage/design-system/svelte';
  import type { DelegationSaveOutcome } from './delegation-contract';
  import { conflictText, reappliedText } from './delegation-model';
  import type { DraftResolution } from './delegation-rebase';
  import { compactList, formActions, noticeStack, workButton } from './delegation-styles';

  let {
    dirty,
    onDiscard,
    onReapply,
    outcome,
    pending,
    resolution,
    revision,
    stale,
  }: {
    /** The form has edits its last save did not carry (made while it was pending, or since). */
    dirty: boolean;
    /** Drops the operator's edits and loads the latest settings. */
    onDiscard: () => Promise<void>;
    /** Loads the latest settings and re-applies the operator's edits onto them. */
    onReapply: () => Promise<void>;
    outcome: DelegationSaveOutcome | null;
    pending: boolean;
    /** The last re-apply of this form's draft, if any. */
    resolution: DraftResolution | null;
    /** The revision the settings are at now; named when the draft went stale under a reload. */
    revision: string;
    /** The settings moved on in what this form writes while its draft was dirty. */
    stale: boolean;
  } = $props();

  // A refused save and a draft gone stale under a reload are the same situation for the operator:
  // the edits are kept and cannot be saved as they are.
  const conflictRevision = $derived.by<string | null>(() => {
    if (stale) {
      return revision;
    }
    return outcome?.kind === 'conflict' ? outcome.revision : null;
  });
  const conflict = $derived(stale || outcome?.kind === 'conflict');
</script>

<div class={noticeStack} data-delegation-save-notice>
  {#if pending}
    <p aria-live="polite" class={banner} role="status">Saving…</p>
  {:else if conflict}
    <div class={cx(banner, bannerError)} data-delegation-conflict role="alert">
      <p>{conflictText(conflictRevision)}</p>
      <div class={formActions}>
        <button class={workButton} onclick={onDiscard} type="button">Discard my edits and load the latest</button>
        <button class={workButton} onclick={onReapply} type="button">Re-apply my edits to the latest</button>
      </div>
    </div>
  {:else if outcome?.kind === 'written'}
    <p aria-live="polite" class={cx(banner, bannerOk)} role="status">
      Saved. The configuration is now at revision {outcome.revision}.
      {#if dirty}
        Edits made since are kept below and not saved yet.
      {/if}
    </p>
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
  {:else if resolution !== null && resolution.conflicts.length === 0}
    <p aria-live="polite" class={cx(banner, bannerOk)} data-delegation-reapplied role="status">
      {reappliedText(resolution)}
    </p>
  {:else if resolution !== null}
    <div class={cx(banner, bannerError)} data-delegation-reapplied role="alert">
      <p>{reappliedText(resolution)}</p>
      <ul class={compactList}>
        {#each resolution.conflicts as entry, index (`${entry.path}:${index}`)}
          <li><code>{entry.path}</code>: yours {entry.mine}, latest {entry.theirs}</li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
