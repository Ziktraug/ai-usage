<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    statusPill,
    statusPillDanger,
    statusPillInfo,
    statusPillOk,
    statusPillWarn,
  } from '@ai-usage/design-system/svelte';
  import type { DelegationQualification } from './delegation-contract';
  import { contextText, harnessDisplayName, ORDER_HINT_TEXT, repositoriesFactText } from './delegation-model';
  import {
    compactList,
    entryTitle,
    factList,
    factMono,
    factTerm,
    factValue,
    monoText,
    plainList,
    routeResult,
    routeResultExcluded,
    sectionTitle,
    workMuted,
    workStack,
  } from './delegation-styles';

  let { qualification }: { qualification: DelegationQualification } = $props();

  const admissible = $derived(qualification.routes.filter((route) => route.admissible));
  const excluded = $derived(qualification.routes.filter((route) => !route.admissible));
  const outcomeText = $derived.by(() => {
    switch (qualification.outcome) {
      case 'routes-available':
        return `${admissible.length} admissible route${admissible.length === 1 ? '' : 's'}; your agent would choose among them.`;
      case 'no-admissible-route':
        return 'No admissible route: every route is excluded below.';
      default:
        return `Refused: ${qualification.refusal?.message ?? qualification.refusal?.reason ?? 'no reason given'}.`;
    }
  });
</script>

<div class={workStack} data-delegation-simulation>
  <p aria-live="polite" class={entryTitle} role="status">{outcomeText}</p>
  <dl class={factList}>
    <div>
      <dt class={factTerm}>Valid until</dt>
      <dd class={factValue}>{qualification.validUntil}</dd>
    </div>
    <div>
      <dt class={factTerm}>Revisions</dt>
      <dd class={factMono}>
        policy {qualification.versions.policyRevision} · catalog {qualification.versions.catalogRevision} ·
        {qualification.versions.qualifier}
      </dd>
    </div>
    {#if qualification.checkout}
      <div>
        <dt class={factTerm}>Checkout</dt>
        <dd class={factValue}>
          {qualification.checkout.path}
          (project {qualification.checkout.projectLabel}) ·
          {qualification.checkout.admittedBy === null
            ? 'not admitted by any review target'
            : `admitted by ${qualification.checkout.admittedBy}`}
        </dd>
      </div>
    {/if}
    {#if qualification.checkoutFacts}
      <div>
        <dt class={factTerm}>GitHub repositories</dt>
        <dd class={factValue} data-delegation-repositories={qualification.checkoutFacts.repositories.provenance}>
          {repositoriesFactText(qualification.checkoutFacts.repositories)}
        </dd>
      </div>
    {/if}
    {#if qualification.scope}
      <div>
        <dt class={factTerm}>Scope</dt>
        <dd class={factMono}>
          {qualification.scope.kind}
          · {qualification.scope.baseSha.slice(0, 12)}..{qualification.scope.headSha.slice(0, 12)}
          ·
          {qualification.scope.commitCount}
          commit{qualification.scope.commitCount === 1 ? '' : 's'}
        </dd>
      </div>
    {/if}
  </dl>

  <h4 class={sectionTitle}>Applied rules</h4>
  {#if qualification.appliedRules.length === 0}
    <p class={workMuted}>No rule applies to this checkout.</p>
  {:else}
    <ul class={compactList} data-delegation-applied-rules>
      {#each qualification.appliedRules as rule (rule.id)}
        <li class={workMuted}>
          <strong>{rule.id}</strong>
          · {rule.effect} ·
          <span class={cx(statusPill, rule.applies === 'yes' ? statusPillInfo : statusPillWarn)}>
            {rule.applies === 'yes' ? 'applies' : 'assumed to apply'}
          </span>
          · {rule.reason}
        </li>
      {/each}
    </ul>
  {/if}

  {#if qualification.assumptions.length > 0}
    <h4 class={sectionTitle}>Assumptions</h4>
    <ul class={plainList} data-delegation-assumptions>
      {#each qualification.assumptions as assumption, index (index)}
        <li>{assumption}</li>
      {/each}
    </ul>
  {/if}

  <h4 class={sectionTitle}>Admissible routes</h4>
  {#if admissible.length === 0}
    <p class={workMuted}>None.</p>
  {/if}
  {#each admissible as route (route.routeId)}
    <article
      aria-labelledby="simulation-route-{route.routeId}"
      class={routeResult}
      data-delegation-admissible={route.routeId}
    >
      <h5 class={entryTitle} id="simulation-route-{route.routeId}">
        {route.label}
        <span class={cx(statusPill, statusPillOk)}>admissible</span>
      </h5>
      <p class={monoText}>
        {harnessDisplayName(route.harness)}
        · {route.provider} · {route.model ?? 'model unknown'} · effort {route.effort ?? 'unknown'} · context
        {contextText(route.context).text}
        · pool {route.poolId} ({route.liveJobsInPool}
        live) · order hint
        {route.orderHint ?? '—'}
        ({ORDER_HINT_TEXT})
      </p>
      <p class={workMuted}>
        Requirements: reserve {route.requirements.reservePercent}% · max concurrent {route.requirements.maxConcurrent} ·
        max attempts {route.requirements.maxAttempts} · identity {route.requirements.identityEvidence}
      </p>
      {#if route.advantages.length > 0}
        <p class={factTerm}>Advantages</p>
        <ul class={plainList}>
          {#each route.advantages as advantage, index (index)}
            <li>{advantage}</li>
          {/each}
        </ul>
      {/if}
      {#if route.limits.length > 0}
        <p class={factTerm}>Limits</p>
        <ul class={plainList}>
          {#each route.limits as limit, index (index)}
            <li>{limit}</li>
          {/each}
        </ul>
      {/if}
    </article>
  {/each}

  <h4 class={sectionTitle}>Excluded routes</h4>
  {#if excluded.length === 0}
    <p class={workMuted}>None.</p>
  {/if}
  {#each excluded as route (route.routeId)}
    <article
      aria-labelledby="simulation-route-{route.routeId}"
      class={cx(routeResult, routeResultExcluded)}
      data-delegation-excluded={route.routeId}
    >
      <h5 class={entryTitle} id="simulation-route-{route.routeId}">
        {route.label}
        <span class={cx(statusPill, statusPillDanger)}>excluded</span>
      </h5>
      <p class={monoText}>
        {harnessDisplayName(route.harness)}
        · {route.provider} · {route.model ?? 'model unknown'} · context
        {contextText(route.context).text}
        · blockers {route.blockers.join(', ') || 'none'}
      </p>
      <ul class={plainList}>
        {#each route.exclusions as exclusion, index (index)}
          <li>{exclusion}</li>
        {/each}
      </ul>
      {#if route.missing.length > 0}
        <p class={factTerm}>Missing data</p>
        <ul class={plainList}>
          {#each route.missing as action, index (index)}
            <li>{action}</li>
          {/each}
        </ul>
      {/if}
    </article>
  {/each}
  {#if qualification.omittedRoutes > 0}
    <p class={workMuted}>{qualification.omittedRoutes} further route(s) omitted to keep the answer bounded.</p>
  {/if}
</div>
