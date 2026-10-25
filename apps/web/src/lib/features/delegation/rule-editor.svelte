<script lang="ts">
  import CheckGroup from './check-group.svelte';
  import type { DelegationConfigIssue, DelegationSettingsView } from './delegation-contract';
  import {
    entryLevelIssues,
    harnessDisplayName,
    IDENTITY_FIELDS_TEXT,
    issueReasonsUnder,
    RULE_EFFECT_TEXT,
    type RuleDraft,
  } from './delegation-model';
  import {
    dangerButton,
    entryCard,
    entryHeader,
    entryTitle,
    fieldError,
    fieldGrid,
    fieldHint,
    fieldsetFrame,
    fieldsetLegend,
  } from './delegation-styles';
  import SelectField from './select-field.svelte';
  import TextField from './text-field.svelte';
  import TextareaField from './textarea-field.svelte';

  let {
    draft = $bindable(),
    githubAccounts,
    index,
    issues,
    onRemove,
  }: {
    draft: RuleDraft;
    githubAccounts: DelegationSettingsView['githubAccounts'];
    index: number;
    issues: readonly DelegationConfigIssue[];
    onRemove: () => void;
  } = $props();

  const path = $derived(`delegation.rules[${index}]`);
  const field = (name: string): string[] => issueReasonsUnder(issues, `${path}.${name}`);

  const effectOptions = [
    { label: 'forbid', value: 'forbid' },
    { label: 'restrict', value: 'restrict' },
    { label: 'require', value: 'require' },
  ] as const;
  const contextOptions = [
    { label: 'professional', value: 'professional' },
    { label: 'personal', value: 'personal' },
  ] as const;
  const harnessOptions = [
    { label: harnessDisplayName('claude-code'), value: 'claude-code' },
    { label: harnessDisplayName('codex'), value: 'codex' },
  ] as const;
  const providerOptions = [
    { label: 'anthropic', value: 'anthropic' },
    { label: 'openai', value: 'openai' },
  ] as const;
  const evidenceOptions = [
    { label: 'no requirement', value: '' },
    { label: 'declared', value: 'declared' },
    { label: 'observed', value: 'observed' },
  ] as const;

  // Requirements are only read on a require rule; leaving them set on another effect is refused.
  const onEffectChange = (effect: RuleDraft['effect']): void => {
    if (effect !== 'require') {
      draft.require = { identityEvidence: '', maxAttempts: '', maxConcurrent: '', reservePercent: '' };
    }
  };
</script>

<div class={entryCard} data-delegation-rule={index}>
  <div class={entryHeader}>
    <span class={entryTitle}>Rule {draft.id || `#${index + 1}`}</span>
    <button class={dangerButton} onclick={onRemove} type="button">Remove rule</button>
  </div>
  {#if entryLevelIssues(issues, path).length > 0}
    <p class={fieldError} data-field-issue role="alert">{entryLevelIssues(issues, path).join(' ')}</p>
  {/if}
  <div class={fieldGrid}>
    <TextField
      hint="Lowercase letters, digits and dashes; starts with a letter or digit."
      id="rule-{index}-id"
      issues={field('id')}
      label="Rule id"
      bind:value={draft.id}
    />
    <SelectField
      hint={RULE_EFFECT_TEXT[draft.effect]}
      id="rule-{index}-effect"
      issues={field('effect')}
      label="Effect"
      onchange={onEffectChange}
      options={effectOptions}
      bind:value={draft.effect}
    />
  </div>
  <TextareaField
    id="rule-{index}-description"
    issues={field('description')}
    label="Description"
    bind:value={draft.description}
  />
  <fieldset class={fieldsetFrame}>
    <legend class={fieldsetLegend}>Match (every given condition must hold; none means everywhere)</legend>
    <p class={fieldHint}>{IDENTITY_FIELDS_TEXT}</p>
    <div class={fieldGrid}>
      <TextField
        hint="Canonical checkout path prefix, compared on path-segment boundaries."
        id="rule-{index}-match-checkout"
        issues={field('match.checkoutPath')}
        label="Checkout path prefix"
        bind:value={draft.match.checkoutPath}
      />
      <TextField
        hint="owner/name of a github.com remote."
        id="rule-{index}-match-repository"
        issues={field('match.repository')}
        label="Repository"
        bind:value={draft.match.repository}
      />
      <TextField
        hint="Owner of a github.com remote."
        id="rule-{index}-match-owner"
        issues={field('match.githubOwner')}
        label="GitHub owner"
        bind:value={draft.match.githubOwner}
      />
      <TextField
        hint="The login declared in github.accounts for the repository owner; not the Git author, not the provider account."
        id="rule-{index}-match-account"
        issues={field('match.githubAccount')}
        label="GitHub account"
        list={githubAccounts.length > 0 ? `rule-${index}-github-accounts` : undefined}
        bind:value={draft.match.githubAccount}
      />
      {#if githubAccounts.length > 0}
        <datalist id="rule-{index}-github-accounts">
          {#each githubAccounts as account (account.owner)}
            <option value={account.ghUser}>{account.ghUser} (owner {account.owner})</option>
          {/each}
        </datalist>
      {/if}
      <TextField
        hint="The checkout's local git config user.email."
        id="rule-{index}-match-author"
        issues={field('match.gitAuthorEmail')}
        label="Git author email"
        bind:value={draft.match.gitAuthorEmail}
      />
    </div>
  </fieldset>
  <fieldset class={fieldsetFrame}>
    <legend class={fieldsetLegend}>Routes the rule selects (none means every route)</legend>
    <div class={fieldGrid}>
      <CheckGroup
        idPrefix="rule-{index}-contexts"
        issues={field('routes.contexts')}
        legend="Contexts"
        options={contextOptions}
        bind:value={draft.routes.contexts}
      />
      <CheckGroup
        idPrefix="rule-{index}-harnesses"
        issues={field('routes.harnesses')}
        legend="Harnesses"
        options={harnessOptions}
        bind:value={draft.routes.harnesses}
      />
      <CheckGroup
        idPrefix="rule-{index}-providers"
        issues={field('routes.providers')}
        legend="Providers"
        options={providerOptions}
        bind:value={draft.routes.providers}
      />
      <TextField
        hint="Separated by commas."
        id="rule-{index}-scopes"
        issues={field('routes.accountScopes')}
        label="Account scopes"
        bind:value={draft.routes.accountScopes}
      />
    </div>
  </fieldset>
  {#if draft.effect === 'require'}
    <fieldset class={fieldsetFrame}>
      <legend class={fieldsetLegend}>Require (at least one; the strictest of all applying rules wins)</legend>
      {#if field('require').length > 0}
        <p class={fieldError} data-field-issue>{field('require').join(' ')}</p>
      {/if}
      <div class={fieldGrid}>
        <SelectField
          id="rule-{index}-require-evidence"
          issues={field('require.identityEvidence')}
          label="Identity evidence"
          options={evidenceOptions}
          bind:value={draft.require.identityEvidence}
        />
        <TextField
          hint="0 to 90."
          id="rule-{index}-require-reserve"
          inputmode="numeric"
          issues={field('require.reservePercent')}
          label="Reserve %"
          bind:value={draft.require.reservePercent}
        />
        <TextField
          hint="1 to 8."
          id="rule-{index}-require-concurrent"
          inputmode="numeric"
          issues={field('require.maxConcurrent')}
          label="Max concurrent"
          bind:value={draft.require.maxConcurrent}
        />
        <TextField
          hint="1 to 5."
          id="rule-{index}-require-attempts"
          inputmode="numeric"
          issues={field('require.maxAttempts')}
          label="Max attempts"
          bind:value={draft.require.maxAttempts}
        />
      </div>
    </fieldset>
  {/if}
</div>
