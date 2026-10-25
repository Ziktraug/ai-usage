<script lang="ts">
  import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import {
    observedReviewCandidates,
    type ReviewRoutingPolicy,
    type ReviewTarget,
    simulateWorkReviewRouting,
  } from '@ai-usage/report-core/work-routing';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { demoReviewCandidates, demoWorkEvidence } from './work-demo';
  import { projectWorkEvidence } from './work-evidence';
  import { workButton, workHeading, workInput, workMuted, workPanel, workRow, workStack } from './work-styles';
  import { WORK_DEMO_TIME } from './work-synthetic';

  let {
    mode,
    providers,
    quotaUnavailable,
    target,
  }: {
    mode: RuntimeMode;
    providers: readonly ProviderStatus[];
    quotaUnavailable: boolean;
    target: SessionPresentationRow;
  } = $props();
  const reviewTarget = $derived<ReviewTarget | null>(
    target.source?.machineId && target.source.sourceSessionId
      ? {
          kind: 'session',
          machineId: target.source.machineId,
          harness: target.source.harnessKey,
          sourceSessionId: target.source.sourceSessionId,
        }
      : null,
  );
  const candidates = $derived.by(() => {
    if (mode === 'live') {
      return observedReviewCandidates(providers);
    }
    return reviewTarget ? demoReviewCandidates(reviewTarget) : [];
  });
  let preferred = $state<ReviewRoutingPolicy['preferredHarness']>('claude-code');
  let nearReset = $state(false);
  let result = $state<ReturnType<typeof simulateWorkReviewRouting> | null>(null);
  const chosen = $derived(candidates.find((candidate) => candidate.id === result?.chosenCandidateId));
  const resetResult = (_input: unknown): void => {
    result = null;
  };
  $effect(() => resetResult({ preferred, nearReset, target: target.rowId, candidates }));
  const simulate = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!reviewTarget) {
      return;
    }
    const policy: ReviewRoutingPolicy = {
      preferredHarness: preferred,
      preferNearReset: nearReset,
      nearResetMinutes: 60,
      forcedCandidateId: null,
    };
    result = simulateWorkReviewRouting({
      request: {
        action: 'read-only-review',
        target: reviewTarget,
        requiredCapabilities: ['read-only-review'],
        minimumQuality: 'review-capable',
      },
      candidates,
      policy,
      referenceTime: mode === 'live' ? new Date().toISOString() : WORK_DEMO_TIME,
    });
  };
</script>

<div class={workStack}>
  <p class={workMuted}>
    Target: {target.sessionLabel || target.name}. Requested action and required capability: read-only review. Minimum
    declared quality: review-capable. Simulation starts no harness and changes no session.
  </p>
  {#if mode === 'live'}
    <p class={workMuted}>
      History and quota do not prove authorization, an available harness or subscription access. Real candidates remain
      unqualified until those facts are observed. Account identity stays unknown when the source omits it.
    </p>
    {#if quotaUnavailable}
      <p class={workMuted}>Current quota observations are unavailable. No eligible capacity is assumed.</p>
    {/if}
  {:else}
    <p class={workMuted}>
      Demo only: two synthetic subscriptions have explicitly declared authorization and capabilities for this target.
    </p>
  {/if}
  {#if !reviewTarget}
    <p class={workMuted} role="status">
      Machine or native session identity is missing. A scoped review cannot be simulated.
    </p>
  {/if}
  <form class={workStack} onsubmit={simulate}>
    <label class={workMuted}
      >Harness preference
      <select class={workInput} bind:value={preferred}>
        <option value="claude-code">Claude Code</option>
        <option value="codex">Codex</option>
        <option value={null}>No preference</option>
      </select>
    </label>
    <label class={workMuted}
      ><input type="checkbox" bind:checked={nearReset}>
      Prefer an eligible quota window resetting within 60 minutes</label
    >
    <p class={workMuted}>
      Constraints first; then an optional near reset, harness preference, and stable candidate identity. Percentages
      from different offers are not compared. A reset never grants authorization.
    </p>
    <div class={workRow}><button class={workButton} disabled={!reviewTarget} type="submit">Run simulation</button></div>
  </form>
  {#if result}
    <section aria-label="Routing result" aria-live="polite" class={workStack}>
      <h3 class={workHeading}>
        {chosen ? `Chosen: ${chosen.harness === 'claude-code' ? 'Claude Code' : 'Codex'}` : 'No eligible candidate'}
      </h3>
      <p class={workMuted}>Simulation reference time: {result.referenceTime}. No execution was started.</p>
      <ul>
        {#each result.reasons as reason}
          <li class={workMuted}>{reason}</li>
        {/each}
      </ul>
      {#if candidates.length === 0}
        <p class={workMuted}>
          No supported machine/provider scope was observed. Candidate, account, authorization and subscription data are
          missing.
        </p>
      {/if}
      {#each result.evaluations as evaluation (evaluation.candidateId)}
        <div class={workPanel}>
          <h4 class={workHeading}>
            {evaluation.candidateId}: {evaluation.eligible ? 'Eligible for simulation' : 'Excluded'}
          </h4>
          <ul>
            {#each evaluation.exclusionReasons as reason}
              <li class={workMuted}>{reason}</li>
            {/each}
          </ul>
          {#if evaluation.missingData.length > 0}
            <p class={workMuted}>Missing data: {evaluation.missingData.join('; ')}.</p>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
  <details>
    <summary class={workHeading}>Candidate evidence ({candidates.length})</summary>
    {#each candidates as candidate (candidate.id)}
      <div class={workPanel}>
        <h3 class={workHeading}>
          {candidate.harness}
          · {candidate.machineLabel ?? candidate.machineId ?? 'Machine unknown'}
        </h3>
        <p class={workMuted}>
          Account: {candidate.accountScope ?? 'unknown'}. Model: {candidate.model ?? 'unknown'}. Effort:
          {candidate.effort ?? 'unknown'}.
        </p>
        <p class={workMuted}>
          {candidate.evidence.source}
          · observed {candidate.evidence.observedAt ?? 'at an unknown time'}.
        </p>
        <p class={workMuted}>
          Authorization: {candidate.authorization}; subscription: {candidate.subscription}; availability:
          {candidate.availability}; declared quality: {candidate.quality}.
        </p>
        {#if candidate.quota}
          <p class={workMuted}>
            Quota state at collection: {candidate.quota.state}. Observed: {candidate.quota.generatedAt}. Offer:
            {candidate.quota.plan ?? 'unknown'}.
          </p>
          <ul>
            {#each candidate.quota.windows as window (window.id)}
              <li class={workMuted}>
                {window.label}: {window.usedPercent ?? 'unknown'}% used · reset {window.resetsAt ?? 'unavailable'} ·
                {window.blocked ? 'blocked' : 'not reported blocked'}
              </li>
            {/each}
          </ul>
        {:else}
          <p class={workMuted}>Quota windows unavailable.</p>
        {/if}
      </div>
    {/each}
  </details>
  {#if mode !== 'live' && reviewTarget}
    <details>
      <summary class={workHeading}>Synthetic evidence examples</summary>
      <p class={workMuted}>Projection-boundary fixtures; these are not collected native outcomes.</p>
      {#each projectWorkEvidence(
        { machineId: reviewTarget.machineId, harness: reviewTarget.harness, sessionId: reviewTarget.sourceSessionId },
        demoWorkEvidence(reviewTarget),
      ) as interpretation}
        <div class={workPanel}>
          <h3 class={workHeading}>{interpretation.text}</h3>
          <p class={workMuted}>Interpretation: {interpretation.uncertainty}</p>
          <ul>
            {#each interpretation.evidence as evidence}
              <li class={workMuted}>
                Fact: {evidence.kind} · {evidence.source} · {evidence.observedAt} · {evidence.coverage} coverage
                {#if evidence.kind === 'pr-opened'}
                  · {evidence.pullRequest.host}/{evidence.pullRequest.repository}#{evidence.pullRequest.number}
                {:else if evidence.kind === 'pr-request'}
                  · {evidence.repository.host}/{evidence.repository.repository}
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </details>
  {/if}
</div>
