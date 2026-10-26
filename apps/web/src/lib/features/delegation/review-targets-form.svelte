<script lang="ts">
  import type { DelegationConfigIssue, DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { createDraftSync, createSaveEpisode } from './delegation-draft.svelte';
  import {
    buildReviewTargets,
    buildSaveInput,
    entryLevelIssues,
    issueReasonsUnder,
    issuesToShow,
    type ReviewTargetDraft,
    reviewTargetDraftFrom,
    reviewTargetIdentity,
  } from './delegation-model';
  import {
    dangerButton,
    entryCard,
    entryHeader,
    entryList,
    fieldError,
    fieldGrid,
    formActions,
    primaryButton,
    sectionIntro,
    sectionTitle,
    workButton,
    workMuted,
    workStack,
  } from './delegation-styles';
  import SaveNotice from './save-notice.svelte';
  import TextField from './text-field.svelte';

  let {
    client,
    onReload,
    settings,
  }: {
    client: DelegationPageClient | null;
    onReload: () => Promise<void>;
    settings: DelegationSettingsView;
  } = $props();

  let nextKey = 0;
  const sync = createDraftSync<(ReviewTargetDraft & { readonly key: string })[]>({
    from: () =>
      settings.reviewTargets.targets.map((target) => ({ ...reviewTargetDraftFrom(target), key: target.checkoutPath })),
    identity: reviewTargetIdentity,
    revision: () => settings.revision,
  });
  const episode = createSaveEpisode<(ReviewTargetDraft & { readonly key: string })[]>({
    client: () => client,
    onWritten: async (written) => {
      sync.settle(written);
      await onReload();
    },
  });
  let localIssues = $state<readonly DelegationConfigIssue[]>([]);
  const issues = $derived<readonly DelegationConfigIssue[]>(issuesToShow(localIssues, episode.outcome));
  const pathOf = (index: number): string => `routing.reviewTargets[${index}]`;

  const add = (): void => {
    sync.markDirty();
    sync.draft.push({ checkoutPath: '', key: `new-target-${++nextKey}`, label: '' });
  };
  const remove = (index: number): void => {
    sync.markDirty();
    sync.draft.splice(index, 1);
  };
  const discard = (): void => {
    localIssues = [];
    episode.clear();
    sync.reset();
  };
  const discardAndReload = async (): Promise<void> => {
    discard();
    await onReload();
  };
  const reapply = async (): Promise<void> => {
    localIssues = [];
    episode.clear();
    await onReload();
    sync.reapply();
  };
  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (sync.stale) {
      return;
    }
    const built = buildReviewTargets(sync.draft);
    if (built.value === null) {
      localIssues = built.issues;
      return;
    }
    localIssues = [];
    await episode.run(buildSaveInput({ reviewTargets: built.value }, sync.baseRevision), sync.snapshot());
  };
</script>

<form
  aria-labelledby="delegation-review-targets-title"
  class={workStack}
  data-delegation-form="review-targets"
  oninput={() => sync.markDirty()}
  onsubmit={submit}
>
  <div class={sectionIntro}>
    <h3 class={sectionTitle} id="delegation-review-targets-title">Review targets</h3>
    <p class={workMuted}>
      Checkouts a worker may read (<code>routing.reviewTargets[]</code>); descendants of a path are admitted too. A
      request for any other path is refused as not admitted.
    </p>
  </div>
  {#if sync.draft.length === 0}
    <p aria-live="polite" class={workMuted}>No checkout is admitted yet; every delegation would be refused.</p>
  {/if}
  <div class={entryList}>
    {#each sync.draft as draft, index (draft.key)}
      {@const entryIssues = entryLevelIssues(issues, pathOf(index))}
      <div class={entryCard} data-delegation-review-target={index}>
        {#if entryIssues.length > 0}
          <p class={fieldError} data-field-issue role="alert">{entryIssues.join(' ')}</p>
        {/if}
        <div class={fieldGrid}>
          <TextField
            hint="Absolute path of the checkout root."
            id="review-target-{index}-path"
            issues={issueReasonsUnder(issues, `${pathOf(index)}.checkoutPath`)}
            label="Checkout path"
            bind:value={draft.checkoutPath}
          />
          <TextField
            id="review-target-{index}-label"
            issues={issueReasonsUnder(issues, `${pathOf(index)}.label`)}
            label="Label"
            bind:value={draft.label}
          />
        </div>
        <div class={entryHeader}>
          <button class={dangerButton} onclick={() => remove(index)} type="button">Remove target</button>
        </div>
      </div>
    {/each}
  </div>
  <div class={formActions}>
    <button class={workButton} onclick={add} type="button">Add review target</button>
    <button class={primaryButton} disabled={episode.pending || sync.stale} type="submit">Save review targets</button>
    <button class={workButton} disabled={!sync.dirty || episode.pending} onclick={discard} type="button">
      Discard edits
    </button>
  </div>
  <SaveNotice
    dirty={sync.dirty}
    onDiscard={discardAndReload}
    onReapply={reapply}
    outcome={episode.outcome}
    pending={episode.pending}
    resolution={sync.resolution}
    revision={settings.revision}
    stale={sync.stale}
  />
</form>
