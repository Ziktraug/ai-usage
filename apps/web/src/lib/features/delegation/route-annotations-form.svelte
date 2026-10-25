<script lang="ts">
  import type { DelegationConfigIssue, DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { createDraftSync, createSaveEpisode } from './delegation-draft.svelte';
  import {
    buildDelegationConfig,
    buildSaveInput,
    defaultsDraftFrom,
    harnessDisplayName,
    issueReasonsUnder,
    issuesToShow,
    modelEntryDraftFrom,
    preferencesDraftFrom,
    type RouteAnnotationDraft,
    routeAnnotationDraftFor,
    routeAnnotationPathFor,
    ruleDraftFrom,
  } from './delegation-model';
  import {
    entryCard,
    entryHeader,
    entryList,
    entryTitle,
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

  const sync = createDraftSync<RouteAnnotationDraft[]>({
    from: () =>
      settings.executors.declarations.map((declaration) =>
        routeAnnotationDraftFor(declaration, settings.delegation.config.routes),
      ),
    revision: () => settings.revision,
  });
  const episode = createSaveEpisode({ client: () => client, onWritten: () => onReload() });
  let localIssues = $state<readonly DelegationConfigIssue[]>([]);
  const issues = $derived<readonly DelegationConfigIssue[]>(issuesToShow(localIssues, episode.outcome));
  const fieldIssues = (key: string, field: string): string[] => {
    const path = routeAnnotationPathFor(sync.draft, key);
    return path === null ? [] : issueReasonsUnder(issues, `${path}.${field}`);
  };

  const contextOptions = [
    { label: 'undeclared — not admissible', value: '' },
    { label: 'professional', value: 'professional' },
    { label: 'personal', value: 'personal' },
  ] as const;

  const discard = (): void => {
    localIssues = [];
    episode.clear();
    sync.reset();
  };
  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const { config } = settings.delegation;
    const built = buildDelegationConfig(
      {
        defaults: defaultsDraftFrom(config.defaults),
        models: config.models.map(modelEntryDraftFrom),
        preferences: preferencesDraftFrom(config.preferences),
        routes: sync.draft,
        rules: config.rules.map(ruleDraftFrom),
      },
      { machineId: settings.machineId, now: new Date().toISOString() },
    );
    if (built.value === null) {
      localIssues = built.issues;
      return;
    }
    localIssues = [];
    const outcome = await episode.run(buildSaveInput({ delegation: built.value }, settings.revision));
    if (outcome.kind === 'written') {
      sync.settle();
    }
  };
</script>

<form
  aria-labelledby="delegation-route-contexts-title"
  class={workStack}
  data-delegation-form="route-annotations"
  oninput={() => sync.markDirty()}
  onsubmit={submit}
>
  <div class={sectionIntro}>
    <h3 class={sectionTitle} id="delegation-route-contexts-title">Route contexts</h3>
    <p class={workMuted}>
      Each declared executor needs a context (<code>delegation.routes[]</code>) before any of its routes is admissible;
      the reserve and concurrency here apply to that account's pool on top of the defaults.
    </p>
  </div>
  {#if sync.draft.length === 0}
    <p aria-live="polite" class={workMuted}>Declare an executor first; its context is set here.</p>
  {/if}
  <div class={entryList}>
    {#each sync.draft as draft, index (draft.key)}
      <div class={entryCard} data-delegation-route-annotation={draft.key}>
        <div class={entryHeader}>
          <span class={entryTitle}>{harnessDisplayName(draft.harness)} · {draft.accountScope}</span>
        </div>
        <div class={fieldGrid}>
          <SelectField
            id="route-{index}-context"
            issues={fieldIssues(draft.key, 'context')}
            label="Context"
            options={contextOptions}
            bind:value={draft.context}
          />
          <TextField
            id="route-{index}-label"
            issues={fieldIssues(draft.key, 'label')}
            label="Label"
            bind:value={draft.label}
          />
          <TextField
            hint="0 to 90; the larger of this and the default applies."
            id="route-{index}-reserve"
            inputmode="numeric"
            issues={fieldIssues(draft.key, 'reservePercent')}
            label="Reserve %"
            bind:value={draft.reservePercent}
          />
          <TextField
            hint="1 to 8 live jobs in this account's pool; the smaller of this and the default applies."
            id="route-{index}-concurrent"
            inputmode="numeric"
            issues={fieldIssues(draft.key, 'maxConcurrent')}
            label="Max concurrent"
            bind:value={draft.maxConcurrent}
          />
        </div>
      </div>
    {/each}
  </div>
  <div class={formActions}>
    <button class={primaryButton} disabled={episode.pending || sync.draft.length === 0} type="submit">
      Save route contexts
    </button>
    <button class={workButton} disabled={!sync.dirty || episode.pending} onclick={discard} type="button">
      Discard edits
    </button>
  </div>
  <SaveNotice {onReload} outcome={episode.outcome} pending={episode.pending} />
</form>
