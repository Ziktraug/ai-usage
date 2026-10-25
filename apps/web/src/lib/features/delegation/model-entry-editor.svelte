<script lang="ts">
  import CheckGroup from './check-group.svelte';
  import type { DelegationCatalogModel, DelegationConfigIssue } from './delegation-contract';
  import {
    entryLevelIssues,
    harnessDisplayName,
    issueReasonsUnder,
    MODEL_DECLARATION_TEXT,
    type ModelEntryDraft,
    SIMULATOR_TASK_CATEGORIES,
  } from './delegation-model';
  import {
    dangerButton,
    entryCard,
    entryHeader,
    entryTitle,
    fieldError,
    fieldGrid,
    fixedText,
    monoText,
  } from './delegation-styles';
  import SelectField from './select-field.svelte';
  import TextField from './text-field.svelte';
  import TextareaField from './textarea-field.svelte';

  let {
    draft = $bindable(),
    index,
    issues,
    observed,
    onRemove,
  }: {
    draft: ModelEntryDraft;
    index: number;
    issues: readonly DelegationConfigIssue[];
    observed: DelegationCatalogModel['observed'];
    onRemove: () => void;
  } = $props();

  const path = $derived(`delegation.models[${index}]`);
  const field = (name: string): string[] => issueReasonsUnder(issues, `${path}.${name}`);

  const providerOptions = [
    { label: 'anthropic', value: 'anthropic' },
    { label: 'openai', value: 'openai' },
  ] as const;
  const harnessOptions = [
    { label: harnessDisplayName('claude-code'), value: 'claude-code' },
    { label: harnessDisplayName('codex'), value: 'codex' },
  ] as const;
  const categoryOptions = SIMULATOR_TASK_CATEGORIES.map((category) => ({ label: category, value: category }));
</script>

<div class={entryCard} data-delegation-model={index}>
  <div class={entryHeader}>
    <span class={entryTitle}>{draft.alias || draft.nativeId || `Model #${index + 1}`}</span>
    <button class={dangerButton} onclick={onRemove} type="button">Remove model</button>
  </div>
  {#if entryLevelIssues(issues, path).length > 0}
    <p class={fieldError} data-field-issue role="alert">{entryLevelIssues(issues, path).join(' ')}</p>
  {/if}
  <div class={fieldGrid}>
    <TextField
      hint="A slug: lowercase letters, digits and dashes."
      id="model-{index}-id"
      issues={field('id')}
      label="Catalog id"
      bind:value={draft.id}
    />
    <SelectField
      id="model-{index}-provider"
      issues={field('provider')}
      label="Provider"
      options={providerOptions}
      bind:value={draft.provider}
    />
    <TextField
      hint="The id the harness accepts."
      id="model-{index}-native-id"
      issues={field('nativeId')}
      label="Native id"
      bind:value={draft.nativeId}
    />
    <TextField id="model-{index}-alias" issues={field('alias')} label="Alias" bind:value={draft.alias} />
    <TextField
      hint="A dated snapshot or version when you know it; empty means unknown, never guessed."
      id="model-{index}-version"
      issues={field('resolvedVersion')}
      label="Resolved version"
      bind:value={draft.resolvedVersion}
    />
  </div>
  <div class={fieldGrid}>
    <CheckGroup
      idPrefix="model-{index}-harnesses"
      issues={field('harnesses')}
      legend="Harnesses"
      options={harnessOptions}
      bind:value={draft.harnesses}
    />
    <CheckGroup
      idPrefix="model-{index}-recommended"
      issues={field('recommendedFor')}
      legend="Recommended for"
      options={categoryOptions}
      bind:value={draft.recommendedFor}
    />
    <CheckGroup
      hint="An annotation in the qualification, never an exclusion."
      idPrefix="model-{index}-discouraged"
      issues={field('discouragedFor')}
      legend="Discouraged for"
      options={categoryOptions}
      bind:value={draft.discouragedFor}
    />
  </div>
  <TextareaField id="model-{index}-note" issues={field('note')} label="Note" bind:value={draft.note} />
  <p class={fixedText}>
    {MODEL_DECLARATION_TEXT}
    {draft.original ? `Declared ${draft.original.declaredAt}.` : 'Dated when saved.'}
  </p>
  <p class={monoText}>
    {#if observed}
      Observed in runs, not a ranking: resolved {observed.modelResolved}, last seen {observed.lastSeenAt},
      {observed.jobs}
      job{observed.jobs === 1 ? '' : 's'}.
    {:else}
      Not observed in any delegation run yet.
    {/if}
  </p>
</div>
