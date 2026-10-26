<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { banner, bannerError } from '@ai-usage/design-system/svelte';
  import type { DelegationConfigIssue, DelegationPageClient, DelegationSimulateOutcome } from './delegation-contract';
  import {
    buildSimulateInput,
    issuesFor,
    newSimulatorDraft,
    SIMULATOR_TASK_CATEGORIES,
    SIMULATOR_TEXT,
  } from './delegation-model';
  import {
    fieldGrid,
    fixedText,
    formActions,
    primaryButton,
    sectionIntro,
    sectionTitle,
    workMuted,
    workStack,
  } from './delegation-styles';
  import SelectField from './select-field.svelte';
  import SimulationResult from './simulation-result.svelte';
  import TextField from './text-field.svelte';
  import TextareaField from './textarea-field.svelte';

  let { client }: { client: DelegationPageClient | null } = $props();

  let draft = $state(newSimulatorDraft());
  let issues = $state<readonly DelegationConfigIssue[]>([]);
  let pending = $state(false);
  let outcome = $state<DelegationSimulateOutcome | null>(null);

  const scopeOptions = [
    { label: 'one commit (against its first parent)', value: 'commit' },
    { label: 'a range base..head', value: 'range' },
  ] as const;
  const categoryOptions = SIMULATOR_TASK_CATEGORIES.map((category) => ({ label: category, value: category }));

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const built = buildSimulateInput(draft);
    if (built.value === null) {
      issues = built.issues;
      return;
    }
    issues = [];
    if (client === null || pending) {
      outcome = { kind: 'unavailable', message: 'The simulator is unavailable in this runtime.', tag: 'Unavailable' };
      return;
    }
    pending = true;
    outcome = null;
    try {
      outcome = await client.simulate(built.value);
    } finally {
      pending = false;
    }
  };
</script>

<form aria-labelledby="delegation-simulator-title" class={workStack} data-delegation-form="simulator" onsubmit={submit}>
  <div class={sectionIntro}>
    <h2 class={sectionTitle} id="delegation-simulator-title">Policy simulator</h2>
    <p class={fixedText}>{SIMULATOR_TEXT}</p>
  </div>
  <div class={fieldGrid}>
    <TextField
      hint="Absolute path of a local checkout; it must be admitted by a review target."
      id="simulator-checkout"
      issues={issuesFor(issues, 'checkoutPath')}
      label="Checkout path"
      bind:value={draft.checkoutPath}
    />
    <SelectField id="simulator-scope" label="Scope" options={scopeOptions} bind:value={draft.scopeKind} />
    {#if draft.scopeKind === 'commit'}
      <TextField
        hint="A branch, tag or SHA; resolved once by the engine."
        id="simulator-commit"
        issues={issuesFor(issues, 'commit')}
        label="Commit"
        bind:value={draft.commit}
      />
    {:else}
      <TextField id="simulator-base" issues={issuesFor(issues, 'base')} label="Base" bind:value={draft.base} />
      <TextField id="simulator-head" issues={issuesFor(issues, 'head')} label="Head" bind:value={draft.head} />
    {/if}
    <SelectField
      id="simulator-category"
      label="Task category"
      options={categoryOptions}
      bind:value={draft.taskCategory}
    />
  </div>
  <TextareaField
    hint="Optional; the objective is part of the request digest but never of the decision."
    id="simulator-objective"
    issues={issuesFor(issues, 'objective')}
    label="Objective"
    bind:value={draft.objective}
  />
  <div class={formActions}>
    <button class={primaryButton} disabled={pending} type="submit">Simulate qualification</button>
    {#if pending}
      <p aria-live="polite" class={workMuted} role="status">Qualifying…</p>
    {/if}
  </div>
  {#if outcome?.kind === 'unavailable'}
    <p class={cx(banner, bannerError)} role="alert">{outcome.message} ({outcome.tag})</p>
  {:else if outcome?.kind === 'qualified'}
    <SimulationResult qualification={outcome.qualification} />
  {/if}
</form>
