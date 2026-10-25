<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { DelegationConfigIssue, DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { createDraftSync, createSaveEpisode } from './delegation-draft.svelte';
  import {
    buildDelegationConfig,
    buildSaveInput,
    type DefaultsDraft,
    defaultsDraftFrom,
    HARNESS_ORDER_OPTIONS,
    type HarnessOrderValue,
    harnessesFromOrder,
    harnessOrderValue,
    issueReasonsUnder,
    issuesToShow,
    modelEntryDraftFrom,
    newRuleDraft,
    type PreferencesDraft,
    preferencesDraftFrom,
    RULE_PRIORITY_TEXT,
    type RuleDraft,
    routeAnnotationDrafts,
    ruleDraftFrom,
  } from './delegation-model';
  import {
    entryList,
    fieldGrid,
    fieldsetFrame,
    fieldsetLegend,
    fixedText,
    formActions,
    primaryButton,
    sectionIntro,
    sectionTitle,
    workButton,
    workMuted,
    workPanel,
    workStack,
  } from './delegation-styles';
  import PolicySimulator from './policy-simulator.svelte';
  import RuleEditor from './rule-editor.svelte';
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

  interface RulesDraft {
    defaults: DefaultsDraft;
    harnessOrder: HarnessOrderValue;
    preferences: PreferencesDraft;
    rules: RuleDraft[];
  }

  let nextKey = 0;
  const sync = createDraftSync<RulesDraft>({
    from: () => ({
      defaults: defaultsDraftFrom(settings.delegation.config.defaults),
      harnessOrder: harnessOrderValue(settings.delegation.config.preferences.harnesses),
      preferences: preferencesDraftFrom(settings.delegation.config.preferences),
      rules: settings.delegation.config.rules.map(ruleDraftFrom),
    }),
    revision: () => settings.revision,
  });
  const episode = createSaveEpisode({ client: () => client, onWritten: () => onReload() });
  let localIssues = $state<readonly DelegationConfigIssue[]>([]);
  const issues = $derived<readonly DelegationConfigIssue[]>(issuesToShow(localIssues, episode.outcome));
  const field = (path: string): string[] => issueReasonsUnder(issues, `delegation.${path}`);

  const evidenceOptions = [
    { label: 'declared', value: 'declared' },
    { label: 'observed', value: 'observed' },
  ] as const;

  const addRule = (): void => {
    sync.markDirty();
    sync.draft.rules.push(newRuleDraft(`new-rule-${++nextKey}`));
  };
  const removeRule = (index: number): void => {
    sync.markDirty();
    sync.draft.rules.splice(index, 1);
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
        defaults: sync.draft.defaults,
        models: config.models.map(modelEntryDraftFrom),
        preferences: { ...sync.draft.preferences, harnesses: harnessesFromOrder(sync.draft.harnessOrder) },
        routes: routeAnnotationDrafts(settings.executors.declarations, config.routes),
        rules: sync.draft.rules,
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

<div class={workStack} data-delegation-section="rules">
  <form
    aria-labelledby="delegation-rules-title"
    class={cx(workPanel, workStack)}
    data-delegation-form="rules"
    oninput={() => sync.markDirty()}
    onsubmit={submit}
  >
    <div class={sectionIntro}>
      <h2 class={sectionTitle} id="delegation-rules-title">Rules</h2>
      <p class={workMuted}>
        Defaults apply to every route; preferences only order the admissible ones; rules forbid, restrict or raise
        requirements where their conditions hold.
      </p>
      <p class={fixedText} data-delegation-priority>{RULE_PRIORITY_TEXT}</p>
    </div>

    <fieldset class={fieldsetFrame}>
      <legend class={fieldsetLegend}>Defaults</legend>
      <div class={fieldGrid}>
        <TextField
          hint="0 to 90: the remaining share each applicable quota window must keep."
          id="defaults-reserve"
          inputmode="numeric"
          issues={field('defaults.reservePercent')}
          label="Reserve %"
          bind:value={sync.draft.defaults.reservePercent}
        />
        <TextField
          hint="1 to 8 live jobs per account pool."
          id="defaults-concurrent"
          inputmode="numeric"
          issues={field('defaults.maxConcurrentPerPool')}
          label="Max concurrent per pool"
          bind:value={sync.draft.defaults.maxConcurrentPerPool}
        />
        <TextField
          hint="1 to 5 jobs in one retry chain."
          id="defaults-attempts"
          inputmode="numeric"
          issues={field('defaults.maxAttempts')}
          label="Max attempts"
          bind:value={sync.draft.defaults.maxAttempts}
        />
        <SelectField
          hint="observed blocks routes whose account is only declared (every Codex route)."
          id="defaults-evidence"
          issues={field('defaults.identityEvidence')}
          label="Identity evidence"
          options={evidenceOptions}
          bind:value={sync.draft.defaults.identityEvidence}
        />
        <TextField
          hint="60 to 3600 seconds a qualification stays valid."
          id="defaults-ttl"
          inputmode="numeric"
          issues={field('defaults.qualificationTtlSeconds')}
          label="Qualification TTL (s)"
          bind:value={sync.draft.defaults.qualificationTtlSeconds}
        />
      </div>
    </fieldset>

    <fieldset class={fieldsetFrame}>
      <legend class={fieldsetLegend}>Preferences (order only; never admit a route)</legend>
      <div class={fieldGrid}>
        <TextField
          hint="Native model ids in preference order, separated by commas."
          id="preferences-models"
          issues={field('preferences.models')}
          label="Model order"
          bind:value={sync.draft.preferences.models}
        />
        <SelectField
          id="preferences-harnesses"
          issues={field('preferences.harnesses')}
          label="Harness order"
          options={HARNESS_ORDER_OPTIONS}
          bind:value={sync.draft.harnessOrder}
        />
        <TextField
          hint="Order routes whose window resets within this many minutes first; empty turns it off."
          id="preferences-near-reset"
          inputmode="numeric"
          issues={field('preferences.nearResetMinutes')}
          label="Near-reset minutes"
          bind:value={sync.draft.preferences.nearResetMinutes}
        />
      </div>
    </fieldset>

    <div class={sectionIntro}>
      <h3 class={sectionTitle} id="delegation-rules-list-title">Rule list</h3>
      {#if sync.draft.rules.length === 0}
        <p aria-live="polite" class={workMuted}>No rule yet: every route with a declared context is admissible.</p>
      {/if}
    </div>
    <div class={entryList}>
      {#each sync.draft.rules as rule, index (rule.key)}
        <RuleEditor
          githubAccounts={settings.githubAccounts}
          {index}
          {issues}
          onRemove={() => removeRule(index)}
          bind:draft={
            () => rule,
            (value) => {
    sync.draft.rules[index] = value;
  }
          }
        />
      {/each}
    </div>
    <div class={formActions}>
      <button class={workButton} onclick={addRule} type="button">Add rule</button>
      <button class={primaryButton} disabled={episode.pending} type="submit">Save rules</button>
      <button class={workButton} disabled={!sync.dirty || episode.pending} onclick={discard} type="button">
        Discard edits
      </button>
    </div>
    <SaveNotice {onReload} outcome={episode.outcome} pending={episode.pending} />
  </form>

  <section aria-labelledby="delegation-simulator-title" class={cx(workPanel, workStack)}>
    <PolicySimulator {client} />
  </section>
</div>
