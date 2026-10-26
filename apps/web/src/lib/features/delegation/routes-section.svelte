<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { statusPill, statusPillInfo, statusPillWarn } from '@ai-usage/design-system/svelte';
  import type { DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { harnessDisplayName, NO_SECRETS_TEXT } from './delegation-model';
  import {
    compactList,
    fixedText,
    monoText,
    sectionIntro,
    sectionTitle,
    workMuted,
    workPanel,
    workStack,
  } from './delegation-styles';
  import ExecutorDeclarationsForm from './executor-declarations-form.svelte';
  import ReviewTargetsForm from './review-targets-form.svelte';
  import RouteAnnotationsForm from './route-annotations-form.svelte';
  import RouteStatusTable from './route-status-table.svelte';

  let {
    client,
    onReload,
    settings,
  }: {
    client: DelegationPageClient | null;
    onReload: () => Promise<void>;
    settings: DelegationSettingsView;
  } = $props();

  const configIssues = $derived([
    ...settings.executors.issues,
    ...settings.reviewTargets.issues,
    ...settings.delegation.issues,
  ]);
</script>

<div class={workStack} data-delegation-section="routes">
  <section aria-labelledby="delegation-routes-title" class={cx(workPanel, workStack)}>
    <div class={sectionIntro}>
      <h2 class={sectionTitle} id="delegation-routes-title">Routes and accounts</h2>
      <p class={workMuted}>
        What each route is now: its declared context, the account it runs under, what the CLI reports and what is
        missing before a delegation could choose it. Declared facts are labelled as such; nothing here is a
        recommendation.
      </p>
      <p class={fixedText}>{NO_SECRETS_TEXT}</p>
    </div>
    {#if configIssues.length > 0}
      <div role="alert">
        <p class={workMuted}>Some configuration entries could not be read and are not shown as routes:</p>
        <ul class={compactList}>
          {#each configIssues as issue, index (`${issue.path}:${index}`)}
            <li class={monoText}>{issue.path}: {issue.reason}</li>
          {/each}
        </ul>
      </div>
    {/if}
    <RouteStatusTable routes={settings.routes} />
    <p class={monoText}>
      Config file: {settings.configPath}{settings.machineId ? ` · machine ${settings.machineId}` : ''}
    </p>
  </section>

  <section aria-labelledby="delegation-harnesses-title" class={cx(workPanel, workStack)}>
    <div class={sectionIntro}>
      <h2 class={sectionTitle} id="delegation-harnesses-title">Harnesses</h2>
      <p class={workMuted}>Which harnesses can execute a delegated review in this version, and who can ask for one.</p>
    </div>
    <ul class={compactList} data-delegation-harnesses>
      {#each settings.harnesses as support (support.harness)}
        <li class={workMuted}>
          <strong>{harnessDisplayName(support.harness)}</strong>
          <span class={cx(statusPill, support.executor === 'supported' ? statusPillInfo : statusPillWarn)}>
            {support.executor === 'supported' ? 'executor supported' : 'executor not supported'}
          </span>
          · {support.reason} · {support.caller}
        </li>
      {/each}
    </ul>
  </section>

  <section class={cx(workPanel, workStack)}>
    <ExecutorDeclarationsForm {client} {onReload} {settings} />
  </section>
  <section class={cx(workPanel, workStack)}>
    <RouteAnnotationsForm {client} {onReload} {settings} />
  </section>
  <section class={cx(workPanel, workStack)}>
    <ReviewTargetsForm {client} {onReload} {settings} />
  </section>
</div>
