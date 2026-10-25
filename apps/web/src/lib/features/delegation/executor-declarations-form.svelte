<script lang="ts">
  import type { DelegationConfigIssue, DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { createDraftSync, createSaveEpisode } from './delegation-draft.svelte';
  import {
    buildExecutors,
    buildSaveInput,
    type ExecutorDraft,
    entryLevelIssues,
    executorDraftFrom,
    harnessDisplayName,
    issueReasonsUnder,
    issuesToShow,
    newExecutorDraft,
    observedFingerprintFor,
  } from './delegation-model';
  import {
    checkItem,
    dangerButton,
    entryCard,
    entryHeader,
    entryList,
    entryTitle,
    fieldError,
    fieldGrid,
    fixedText,
    formActions,
    primaryButton,
    sectionIntro,
    sectionTitle,
    workButton,
    workMuted,
    workStack,
  } from './delegation-styles';
  import SaveNotice from './save-notice.svelte';
  import SelectField from './select-field.svelte';
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
  const sync = createDraftSync<ExecutorDraft[]>({
    from: () => settings.executors.declarations.map(executorDraftFrom),
    revision: () => settings.revision,
  });
  const episode = createSaveEpisode<ExecutorDraft[]>({
    client: () => client,
    onWritten: async ({ revision, saved }) => {
      sync.settle(saved, revision);
      await onReload();
    },
  });
  let localIssues = $state<readonly DelegationConfigIssue[]>([]);
  const issues = $derived<readonly DelegationConfigIssue[]>(issuesToShow(localIssues, episode.outcome));
  const pathOf = (index: number): string => `routing.executors[${index}]`;
  const fieldIssues = (index: number, field: string): string[] =>
    issueReasonsUnder(issues, `${pathOf(index)}.${field}`);

  const harnessOptions = [
    { label: harnessDisplayName('claude-code'), value: 'claude-code' },
    { label: harnessDisplayName('codex'), value: 'codex' },
  ] as const;
  const authorizationOptions = [
    { label: 'allowed', value: 'allowed' },
    { label: 'forbidden', value: 'forbidden' },
  ] as const;
  const subscriptionOptions = [
    { label: 'verified subscription', value: 'verified' },
    { label: 'api (never admissible)', value: 'api' },
  ] as const;

  const add = (): void => {
    sync.markDirty();
    sync.draft.push({ ...newExecutorDraft(`new-executor-${++nextKey}`), machineId: settings.machineId ?? '' });
  };
  const remove = (index: number): void => {
    sync.markDirty();
    sync.draft.splice(index, 1);
  };
  const pinObserved = (draft: ExecutorDraft, fingerprint: string): void => {
    sync.markDirty();
    draft.accountFingerprint = fingerprint;
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
    const built = buildExecutors(sync.draft, { machineId: settings.machineId, now: new Date().toISOString() });
    if (built.value === null) {
      localIssues = built.issues;
      return;
    }
    localIssues = [];
    await episode.run(buildSaveInput({ executors: built.value }, sync.baseRevision), sync.snapshot());
  };
</script>

<form
  aria-labelledby="delegation-executors-title"
  class={workStack}
  data-delegation-form="executors"
  oninput={() => sync.markDirty()}
  onsubmit={submit}
>
  <div class={sectionIntro}>
    <h3 class={sectionTitle} id="delegation-executors-title">Executor declarations</h3>
    <p class={workMuted}>
      One entry per harness and account that may run a read-only review (<code>routing.executors[]</code>). The
      capabilities are fixed to read-only-review and the quality to review-capable in this version; a changed entry is
      dated when saved.
    </p>
  </div>
  {#if sync.draft.length === 0}
    <p aria-live="polite" class={workMuted}>No executor declared yet.</p>
  {/if}
  <div class={entryList}>
    {#each sync.draft as draft, index (draft.key)}
      {@const observed = observedFingerprintFor(settings.routes, draft)}
      {@const entryIssues = entryLevelIssues(issues, pathOf(index))}
      <div class={entryCard} data-delegation-executor={index}>
        <div class={entryHeader}>
          <span class={entryTitle}
            >{harnessDisplayName(draft.harness)}
            · {draft.accountScope || 'new account scope'}</span
          >
          <button class={dangerButton} onclick={() => remove(index)} type="button">Remove declaration</button>
        </div>
        {#if entryIssues.length > 0}
          <p class={fieldError} data-field-issue role="alert">{entryIssues.join(' ')}</p>
        {/if}
        <div class={fieldGrid}>
          <SelectField
            id="executor-{index}-harness"
            issues={fieldIssues(index, 'harness')}
            label="Harness"
            options={harnessOptions}
            bind:value={draft.harness}
          />
          <TextField
            hint="The account suffix of the quota key, or your own name for the account."
            id="executor-{index}-account-scope"
            issues={fieldIssues(index, 'accountScope')}
            label="Account scope"
            bind:value={draft.accountScope}
          />
          <SelectField
            id="executor-{index}-authorization"
            issues={fieldIssues(index, 'authorization')}
            label="Authorization"
            options={authorizationOptions}
            bind:value={draft.authorization}
          />
          <SelectField
            hint="Only a verified subscription is admissible; api names an API-key account and is never admissible."
            id="executor-{index}-subscription"
            issues={fieldIssues(index, 'subscription')}
            label="Subscription"
            options={subscriptionOptions}
            bind:value={draft.subscription}
          />
          <TextField
            hint="Preferred model; empty leaves it to the harness."
            id="executor-{index}-model"
            issues={fieldIssues(index, 'model')}
            label="Model"
            bind:value={draft.model}
          />
          <TextField
            hint="Further models of the same account, in order, separated by commas; they share its quota."
            id="executor-{index}-alternate-models"
            issues={fieldIssues(index, 'alternateModels')}
            label="Alternate models"
            bind:value={draft.alternateModels}
          />
          <TextField
            id="executor-{index}-effort"
            issues={fieldIssues(index, 'effort')}
            label="Effort"
            bind:value={draft.effort}
          />
          <TextField
            hint="Empty means this machine."
            id="executor-{index}-machine"
            issues={fieldIssues(index, 'machineId')}
            label="Machine"
            bind:value={draft.machineId}
          />
        </div>
        <div class={fieldGrid}>
          <TextField
            hint={observed === null
              ? 'The 16-character fingerprint the Work view shows; empty pins no account.'
              : `Observed now: ${observed}. Pinning binds this route to that account.`}
            id="executor-{index}-fingerprint"
            issues={fieldIssues(index, 'accountFingerprint')}
            label="Pinned account fingerprint"
            bind:value={draft.accountFingerprint}
          />
          {#if observed !== null && observed !== draft.accountFingerprint}
            <div class={formActions}>
              <button class={workButton} onclick={() => pinObserved(draft, observed)} type="button">
                Pin observed {observed}
              </button>
            </div>
          {/if}
        </div>
        <div class={fieldGrid}>
          <label class={checkItem} for="executor-{index}-any-session">
            <input id="executor-{index}-any-session" type="checkbox" bind:checked={draft.targetsAnyLocalSession}>
            Any local session may be reviewed
          </label>
          <TextField
            hint="Project labels the route may review, separated by commas."
            id="executor-{index}-projects"
            issues={fieldIssues(index, 'targets')}
            label="Project targets"
            bind:value={draft.projectLabels}
          />
        </div>
        <p class={fixedText}>
          Capabilities: read-only-review · Quality: review-capable · Declared {draft.original?.declaredAt ?? 'on save'}
        </p>
      </div>
    {/each}
  </div>
  <div class={formActions}>
    <button class={workButton} onclick={add} type="button">Add declaration</button>
    <button class={primaryButton} disabled={episode.pending || sync.stale} type="submit">Save declarations</button>
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
