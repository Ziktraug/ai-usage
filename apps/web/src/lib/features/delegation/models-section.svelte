<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { DelegationConfigIssue, DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { createDraftSync, createSaveEpisode } from './delegation-draft.svelte';
  import {
    buildDelegationConfig,
    buildSaveInput,
    defaultsDraftFrom,
    harnessDisplayName,
    issuesToShow,
    MODEL_DECLARATION_TEXT,
    type ModelEntryDraft,
    modelEntryDraftFrom,
    newModelEntryDraft,
    OBSERVED_MODELS_TEXT,
    preferencesDraftFrom,
    routeAnnotationDraftFor,
    ruleDraftFrom,
  } from './delegation-model';
  import {
    entryList,
    fixedText,
    formActions,
    primaryButton,
    sectionIntro,
    sectionTitle,
    statusTable,
    tableFrameAlways,
    workButton,
    workMuted,
    workPanel,
    workStack,
  } from './delegation-styles';
  import ModelEntryEditor from './model-entry-editor.svelte';
  import SaveNotice from './save-notice.svelte';

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
  const sync = createDraftSync<ModelEntryDraft[]>({
    from: () => settings.models.map((model) => modelEntryDraftFrom(model.entry)),
    revision: () => settings.revision,
  });
  const episode = createSaveEpisode({ client: () => client, onWritten: () => onReload() });
  let localIssues = $state<readonly DelegationConfigIssue[]>([]);
  const issues = $derived<readonly DelegationConfigIssue[]>(issuesToShow(localIssues, episode.outcome));
  const observedFor = (draft: ModelEntryDraft) =>
    settings.models.find((model) => model.entry.id === draft.original?.id)?.observed ?? null;

  const add = (): void => {
    sync.markDirty();
    sync.draft.push(newModelEntryDraft(`new-model-${++nextKey}`));
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
  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const { config } = settings.delegation;
    const built = buildDelegationConfig(
      {
        defaults: defaultsDraftFrom(config.defaults),
        models: sync.draft,
        preferences: preferencesDraftFrom(config.preferences),
        routes: settings.executors.declarations.map((declaration) =>
          routeAnnotationDraftFor(declaration, config.routes),
        ),
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

<div class={workStack} data-delegation-section="models">
  <form
    aria-labelledby="delegation-models-title"
    class={cx(workPanel, workStack)}
    data-delegation-form="models"
    oninput={() => sync.markDirty()}
    onsubmit={submit}
  >
    <div class={sectionIntro}>
      <h2 class={sectionTitle} id="delegation-models-title">Model catalog</h2>
      <p class={workMuted}>
        What you declare about each model: where it runs, what you recommend or discourage it for, and the version you
        know. The qualification annotates routes with it; it never ranks models.
      </p>
      <p class={fixedText}>{MODEL_DECLARATION_TEXT}</p>
    </div>
    {#if sync.draft.length === 0}
      <p aria-live="polite" class={workMuted}>No model declared yet.</p>
    {/if}
    <div class={entryList}>
      {#each sync.draft as draft, index (draft.key)}
        <ModelEntryEditor
          {index}
          {issues}
          observed={observedFor(draft)}
          onRemove={() => remove(index)}
          bind:draft={
            () => draft,
            (value) => {
    sync.draft[index] = value;
  }
          }
        />
      {/each}
    </div>
    <div class={formActions}>
      <button class={workButton} onclick={add} type="button">Add model</button>
      <button class={primaryButton} disabled={episode.pending} type="submit">Save models</button>
      <button class={workButton} disabled={!sync.dirty || episode.pending} onclick={discard} type="button">
        Discard edits
      </button>
    </div>
    <SaveNotice {onReload} outcome={episode.outcome} pending={episode.pending} />
  </form>

  <section aria-labelledby="delegation-observed-models-title" class={cx(workPanel, workStack)}>
    <div class={sectionIntro}>
      <h2 class={sectionTitle} id="delegation-observed-models-title">Models observed in runs</h2>
      <p class={fixedText} data-delegation-observed-models-note>{OBSERVED_MODELS_TEXT}</p>
    </div>
    {#if settings.observedModels.length === 0}
      <p aria-live="polite" class={workMuted}>No delegation run has reported a model yet.</p>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a horizontally scrollable region must be keyboard-reachable -->
      <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
      <section aria-label="Observed models table" class={tableFrameAlways} tabindex="0">
        <table class={statusTable} data-delegation-observed-models>
          <thead>
            <tr>
              <th scope="col">Harness</th>
              <th scope="col">Requested</th>
              <th scope="col">Resolved</th>
              <th scope="col">Last seen</th>
              <th scope="col">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {#each settings.observedModels as observed (`${observed.harness}/${observed.modelRequested}/${observed.modelResolved ?? ''}`)}
              <tr>
                <td>{harnessDisplayName(observed.harness)}</td>
                <td>{observed.modelRequested}</td>
                <td>{observed.modelResolved ?? 'unknown (not reported)'}</td>
                <td>{observed.lastSeenAt}</td>
                <td>{observed.jobs}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  </section>
</div>
