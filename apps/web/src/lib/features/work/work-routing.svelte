<script lang="ts">
  import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import {
    assessReviewRecommendation,
    CANDIDATE_PROVENANCE_FIELDS,
    type CandidateProvenanceField,
    qualifyReviewCandidates,
    type ReviewCandidate,
    type ReviewRoutingPolicy,
    type ReviewTarget,
    simulateWorkReviewRouting,
  } from '@ai-usage/report-core/work-routing';
  import type { WorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
  import type { WorkRoutingContext, WorkRoutingQualifyOutput } from '@ai-usage/web-contract/work-routing';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { workAttemptsKey, workAttemptsQueryOptions } from '../../query/options/work-attempts';
  import { workRoutingContextKey, workRoutingContextQueryOptions } from '../../query/options/work-routing';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import { createWorkAttemptsClient } from '../../rpc/work-attempts-client';
  import { createWorkRoutingClient, createWorkRoutingQualifyClient } from '../../rpc/work-routing-client';
  import WorkAttempts from './work-attempts.svelte';
  import {
    DEMO_EXECUTION_TEXT,
    launchGate,
    releaseOutcomeText,
    startReviewLabel,
    stopOutcomeText,
  } from './work-attempts-model';
  import { demoReviewCandidates, demoWorkEvidence } from './work-demo';
  import { projectWorkEvidence } from './work-evidence';
  import {
    identityLine,
    qualificationFreshnessText,
    qualificationHeadline,
    routingSummary,
  } from './work-routing-model';
  import {
    workButton,
    workHeading,
    workInput,
    workMuted,
    workPanel,
    workRoutingForm,
    workRow,
    workStack,
  } from './work-styles';
  import { WORK_DEMO_TIME } from './work-synthetic';

  let {
    attempts,
    context,
    mode,
    providers,
    qualification,
    quotaUnavailable,
    target,
  }: {
    /**
     * The review attempts of this target and its resolved checkout. Omit it and the component reads
     * them itself in live mode; pass `null` to state that they are unavailable.
     */
    attempts?: WorkAttemptsListOutput | null;
    /**
     * The declared executors and executor observations. Omit it and the component reads the
     * context itself in live mode; pass `null` to state that it is unavailable.
     */
    context?: WorkRoutingContext | null;
    mode: RuntimeMode;
    providers: readonly ProviderStatus[];
    /**
     * The engine's decision for this target (ADR 0057). Omit it and the component asks the engine
     * on "Qualify now"; pass one to render a supplied decision, or `null` to state none was taken.
     */
    qualification?: WorkRoutingQualifyOutput | null;
    quotaUnavailable: boolean;
    target: SessionPresentationRow;
  } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const queryClient = useQueryClient();
  const routingClient = untrack(() =>
    browser && rpc
      ? createWorkRoutingClient(rpc.workRouting)
      : ssrUnavailableClient<ReturnType<typeof createWorkRoutingClient>>('Work routing context'),
  );
  const qualifyClient = untrack(() =>
    browser && rpc
      ? createWorkRoutingQualifyClient(rpc.workRouting)
      : ssrUnavailableClient<ReturnType<typeof createWorkRoutingQualifyClient>>('Work routing qualification'),
  );
  const attemptsClient = untrack(() =>
    browser && rpc
      ? createWorkAttemptsClient(rpc.workAttempts)
      : ssrUnavailableClient<ReturnType<typeof createWorkAttemptsClient>>('Work attempts'),
  );
  const contextQuery = createQuery(() =>
    workRoutingContextQueryOptions(routingClient, {
      browser,
      enabled: mode === 'live' && context === undefined,
    }),
  );
  const resolvedContext = $derived.by<WorkRoutingContext | null>(() => {
    if (context !== undefined) {
      return context;
    }
    return contextQuery.data?.ok ? contextQuery.data.data : null;
  });
  const contextError = $derived.by<{ readonly message: string; readonly tag: string } | null>(() => {
    if (context !== undefined) {
      return null;
    }
    if (contextQuery.data && !contextQuery.data.ok) {
      return contextQuery.data.error;
    }
    // A transport failure carries no safe detail for the page; the tag is enough to act on.
    return contextQuery.error ? { message: 'The request did not complete.', tag: 'Unavailable' } : null;
  });
  const reviewTarget = $derived<ReviewTarget | null>(
    target.source?.machineId && target.source.sourceSessionId
      ? {
          kind: 'session',
          machineId: target.source.machineId,
          harness: target.source.harnessKey,
          sourceSessionId: target.source.sourceSessionId,
          projectLabel: target.projectLabel ?? null,
        }
      : null,
  );
  // One reference time per qualification: provenance (observed-now / stale) is judged against it,
  // and the simulation reuses it so both agree. Refreshed whenever the inputs change.
  let referenceTime = $state(untrack(() => mode) === 'live' ? new Date().toISOString() : WORK_DEMO_TIME);
  const candidates = $derived.by<readonly ReviewCandidate[]>(() => {
    if (mode !== 'live') {
      return reviewTarget ? demoReviewCandidates(reviewTarget) : [];
    }
    if (!resolvedContext) {
      return [];
    }
    return qualifyReviewCandidates({
      declarations: resolvedContext.declarations,
      executorObservations: resolvedContext.executorObservations,
      now: referenceTime,
      providers,
      target: reviewTarget,
    });
  });
  const summary = $derived(
    mode === 'live' && resolvedContext
      ? routingSummary({ candidates, context: resolvedContext, referenceTime, target: reviewTarget })
      : [],
  );
  // The engine's decision (ADR 0057): one fresh qualification per click, never a cached dataset.
  let engine = $state<{ readonly output: WorkRoutingQualifyOutput | null; readonly pending: boolean }>({
    output: null,
    pending: false,
  });
  let qualificationGeneration = 0;
  const resolvedQualification = $derived(qualification === undefined ? engine.output : qualification);
  const engineDecision = $derived(resolvedQualification?.ok ? resolvedQualification.data : null);
  const qualifyNow = async (): Promise<void> => {
    if (!reviewTarget || engine.pending || mode !== 'live') {
      return;
    }
    const generation = ++qualificationGeneration;
    const targetRowId = target.rowId;
    engine = { output: engine.output, pending: true };
    const output = await qualifyClient.qualify({
      target: { desktopSessionId: null, harness: reviewTarget.harness, sourceSessionId: reviewTarget.sourceSessionId },
    });
    // A returned-to session is a new selection; identity alone cannot protect A → B → A.
    if (generation !== qualificationGeneration || targetRowId !== target.rowId) {
      return;
    }
    engine = { output, pending: false };
    result = null;
    // The engine has just recorded a new executor observation: the summary above re-reads it.
    await queryClient.invalidateQueries({ queryKey: workRoutingContextKey() });
  };
  const resetEngine = (_target: string): void => {
    qualificationGeneration += 1;
    engine = { output: null, pending: false };
    launch = { message: null, pending: false };
  };
  $effect(() => {
    resetEngine(target.rowId);
    return () => {
      qualificationGeneration += 1;
    };
  });
  let preferred = $state<ReviewRoutingPolicy['preferredHarness']>('claude-code');
  let forcedCandidateId = $state<string | null>(null);
  let nearReset = $state(false);
  let result = $state<ReturnType<typeof simulateWorkReviewRouting> | null>(null);
  const chosen = $derived(candidates.find((candidate) => candidate.id === result?.chosenCandidateId));
  const recommendation = $derived(result ? assessReviewRecommendation(result, candidates) : null);
  const alternatives = $derived(
    result ? result.evaluations.filter((evaluation) => evaluation.candidateId !== result?.chosenCandidateId) : [],
  );
  // Execution (ADR 0053): the list of attempts for this target and its resolved checkout come from
  // the store through `workAttempts.list`; the button only asks the engine, which re-decides.
  const attemptsTarget = $derived(
    reviewTarget ? { harness: reviewTarget.harness, sourceSessionId: reviewTarget.sourceSessionId } : null,
  );
  const attemptsQuery = createQuery(() =>
    workAttemptsQueryOptions(attemptsClient, attemptsTarget ?? { harness: 'none', sourceSessionId: 'none' }, {
      browser,
      enabled: mode === 'live' && attempts === undefined && attemptsTarget !== null,
    }),
  );
  const resolvedAttempts = $derived.by<WorkAttemptsListOutput | null>(() => {
    if (attempts !== undefined) {
      return attempts;
    }
    if (attemptsQuery.data) {
      return attemptsQuery.data;
    }
    return attemptsQuery.error
      ? { error: { message: 'The request did not complete.', tag: 'Unavailable' }, ok: false }
      : null;
  });
  const attemptsPending = $derived(attempts === undefined && mode === 'live' && attemptsQuery.isPending);
  // A selected route must be simulated before it can replace an engine recommendation.
  const launchCandidate = $derived(
    result
      ? chosen
      : candidates.find(
          (candidate) =>
            candidate.id === engineDecision?.chosenCandidateId &&
            (forcedCandidateId === null || candidate.id === forcedCandidateId),
        ),
  );
  const gate = $derived(
    launchGate({
      attempts: resolvedAttempts,
      attemptsPending,
      chosen: launchCandidate,
      recommendation: result ? recommendation : (engineDecision?.recommendation ?? null),
      reviewTargetsDeclared: resolvedContext?.reviewTargets?.length ?? 0,
    }),
  );
  const launchCandidateId = $derived(launchCandidate?.id ?? null);
  let launch = $state<{ readonly message: string | null; readonly pending: boolean }>({
    message: null,
    pending: false,
  });
  const startReview = async (): Promise<void> => {
    if (!(reviewTarget && launchCandidateId) || launch.pending || gate.kind !== 'open') {
      return;
    }
    const targetKey = attemptsTarget;
    const targetRowId = target.rowId;
    launch = { message: 'Starting the review…', pending: true };
    const output = await attemptsClient.start({
      action: 'read-only-review',
      candidateId: launchCandidateId,
      target: { desktopSessionId: null, harness: reviewTarget.harness, sourceSessionId: reviewTarget.sourceSessionId },
    });
    if (targetRowId === target.rowId) {
      launch = {
        message: output.ok
          ? `Review attempt ${output.data.attemptId.slice(0, 8)} ${output.data.reused ? 'was already live' : 'started'} (${output.data.state}); follow it below.`
          : `Not started: ${output.error.message}`,
        pending: false,
      };
    }
    if (targetKey) {
      await queryClient.invalidateQueries({ queryKey: workAttemptsKey(targetKey) });
    }
  };
  /** The operator's release of a held reservation (ADR 0055); the engine decides and stops nothing. */
  const releaseReservation = async (attemptId: string): Promise<string> => {
    const output = await attemptsClient.release({ attemptId });
    if (attemptsTarget) {
      await queryClient.invalidateQueries({ queryKey: workAttemptsKey(attemptsTarget) });
    }
    return releaseOutcomeText(output);
  };
  const stopReview = async (attemptId: string): Promise<string> => {
    const targetKey = attemptsTarget;
    const output = await attemptsClient.stop({ attemptId });
    if (targetKey) {
      await queryClient.invalidateQueries({ queryKey: workAttemptsKey(targetKey) });
    }
    return stopOutcomeText(output);
  };
  const resetResult = (_input: unknown): void => {
    result = null;
    if (mode === 'live') {
      referenceTime = new Date().toISOString();
    }
  };
  $effect(() =>
    resetResult({ preferred, nearReset, forcedCandidateId, target: target.rowId, resolvedContext, providers }),
  );
  const simulate = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!reviewTarget) {
      return;
    }
    if (mode === 'live') {
      referenceTime = new Date().toISOString();
    }
    const policy: ReviewRoutingPolicy = {
      preferredHarness: preferred,
      preferNearReset: nearReset,
      nearResetMinutes: 60,
      forcedCandidateId,
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
      referenceTime,
    });
  };
  const harnessLabel = (harness: ReviewCandidate['harness']): string =>
    harness === 'claude-code' ? 'Claude Code' : 'Codex';
  const candidateById = (id: string): ReviewCandidate | undefined =>
    candidates.find((candidate) => candidate.id === id);
  const provenanceLabel = (candidate: ReviewCandidate, field: CandidateProvenanceField): string => {
    const origin = candidate.provenance[field];
    if (origin === 'declared') {
      return `declared ${candidate.evidence.observedAt ?? ''}`.trim();
    }
    if (origin === 'stale') {
      const at =
        field === 'quota'
          ? candidate.quota?.generatedAt
          : resolvedContext?.executorObservations.find(
              (observation) =>
                observation.machineId === candidate.machineId && observation.harness === candidate.harness,
            )?.observedAt;
      return `stale${at ? ` ${at}` : ''}`;
    }
    return origin;
  };
  const fieldValue = (candidate: ReviewCandidate, field: CandidateProvenanceField): string => {
    switch (field) {
      case 'accountScope':
        return candidate.accountScope ?? 'unknown';
      case 'authorization':
        return candidate.authorization;
      case 'subscription':
        return `${candidate.subscription}${candidate.quota?.plan ? ` (plan observed: ${candidate.quota.plan})` : ''}`;
      case 'availability':
        return candidate.availability;
      case 'capabilities':
        return candidate.capabilities.length > 0 ? candidate.capabilities.join(', ') : 'none';
      case 'quality':
        return candidate.quality;
      case 'quota':
        return candidate.quota ? `${candidate.quota.state} at ${candidate.quota.generatedAt}` : 'unavailable';
      case 'model':
        return candidate.model ?? 'unknown';
      case 'effort':
        return candidate.effort ?? 'unknown';
      default:
        return 'unknown';
    }
  };
  const fieldLabel: Record<CandidateProvenanceField, string> = {
    accountScope: 'Account',
    authorization: 'Authorization',
    subscription: 'Subscription',
    availability: 'Availability',
    capabilities: 'Capabilities',
    quality: 'Quality',
    quota: 'Quota',
    model: 'Model',
    effort: 'Effort',
  };
</script>

<div class={workStack}>
  <p class={workMuted}>
    Target: {target.sessionLabel || target.name}. Requested action and required capability: read-only review. Minimum
    declared quality: review-capable. Simulation starts no harness and changes no session.
  </p>
  {#if mode === 'live'}
    <p class={workMuted}>
      Authorization, subscription and capabilities come only from your declarations in
      {resolvedContext?.configPath ?? '~/.config/ai-usage/config.json'}
      (routing.executors). Availability comes from the engine's executor observations; quota from the stored usage-limit
      observations. Each field names its provenance; nothing is inferred across them.
    </p>
    {#if context === undefined && contextQuery.isPending}
      <p class={workMuted} role="status">Reading routing declarations and executor observations…</p>
    {:else if !resolvedContext}
      <p class={workMuted} role="status">
        Routing context unavailable{contextError ? ` (${contextError.tag}: ${contextError.message})` : ''}. No candidate
        can be qualified: declarations and executor observations are unknown.
      </p>
    {:else}
      {#if resolvedContext.declarations.length === 0}
        <p class={workMuted}>
          No executor is declared. Add a routing.executors[] entry to the home config to authorize a harness; quota and
          executor observations alone never qualify a candidate.
        </p>
      {/if}
      {#if resolvedContext.declarationErrors.length > 0}
        <div class={workPanel}>
          <h3 class={workHeading}>Declaration entries not read ({resolvedContext.declarationErrors.length})</h3>
          <ul>
            {#each resolvedContext.declarationErrors as issue}
              <li class={workMuted}>{issue}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if resolvedContext.observationRead && (resolvedContext.observationRead.skipped > 0 || resolvedContext.observationRead.truncated)}
        <p class={workMuted}>
          Executor observations partially read: {resolvedContext.observationRead.skipped} refused on re-validation{resolvedContext.observationRead.truncated ? '; read bound reached' : ''}.
        </p>
      {/if}
    {/if}
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
  {#if summary.length > 0}
    <details aria-label="Routing qualification on this machine" class={workStack} data-work-qualification="summary">
      <summary class={workHeading}>Routing qualification on this machine</summary>
      <p class={workMuted}>
        Once per machine, not per card: what the engine detected, what you declared, whether this session is an
        authorized target, and what is missing. A permission exists only as a declaration in the home config.
      </p>
      {#each summary as row (row.harness)}
        <div class={workPanel} data-work-qualification-harness={row.harness}>
          <h4 class={workHeading}>{row.label}</h4>
          <ul>
            <li class={workMuted}>{row.detected}</li>
            {#each row.declared as line}
              <li class={workMuted}>{line}</li>
            {/each}
            {#each row.identity as line}
              <li class={workMuted}>{line}</li>
            {/each}
            <li class={workMuted}>{row.target}</li>
            <li class={workMuted}>{row.execution}</li>
          </ul>
          {#if row.missing.length > 0}
            <p class={workMuted}>Missing for {row.label}:</p>
            <ul>
              {#each row.missing as action}
                <li class={workMuted}>{action}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </details>
  {/if}
  {#if mode === 'live' && reviewTarget}
    <div class={workRow}>
      <button class={workButton} disabled={engine.pending} onclick={qualifyNow} type="button">
        Qualify now with the engine
      </button>
    </div>
    <p class={workMuted}>
      The engine observes the harness CLIs now (version and sign-in status commands, nothing generated), re-reads your
      declarations and the stored quota, and decides with the launch policy. Nothing is started.
    </p>
    {#if engine.pending}
      <p class={workMuted} role="status">The engine is qualifying the routing…</p>
    {/if}
  {/if}
  {#if resolvedQualification && !resolvedQualification.ok}
    <p class={workMuted} data-work-qualification="unavailable" role="status">
      Engine qualification unavailable ({resolvedQualification.error.tag}: {resolvedQualification.error.message}).
    </p>
  {:else if engineDecision}
    <section
      aria-label="Engine qualification"
      aria-live="polite"
      class={workStack}
      data-work-qualification={engineDecision.recommendation.kind}
    >
      <h3 class={workHeading}>{qualificationHeadline(engineDecision)}</h3>
      <p class={workMuted}>{qualificationFreshnessText(engineDecision)}</p>
      <ul>
        {#each engineDecision.reasons as reason}
          <li class={workMuted}>{reason}</li>
        {/each}
      </ul>
      {#each engineDecision.candidates as entry (entry.candidateId)}
        <div class={workPanel}>
          <h4 class={workHeading}>
            {entry.harness === 'claude-code' ? 'Claude Code' : 'Codex'}
            · {entry.accountScope ?? 'account unknown'} ·
            {entry.model ?? 'model not declared'}:
            {#if entry.candidateId === engineDecision.chosenCandidateId}
              chosen
            {:else}
              {entry.eligible ? 'eligible, not preferred' : 'excluded'}
            {/if}
          </h4>
          {#if entry.identity}
            <p class={workMuted}>{identityLine(entry.identity)}</p>
          {/if}
          {#if entry.exclusionReasons.length > 0}
            <ul>
              {#each entry.exclusionReasons as reason}
                <li class={workMuted}>{reason}</li>
              {/each}
            </ul>
          {/if}
          {#if entry.missingData.length > 0}
            <p class={workMuted}>Limits and missing data: {entry.missingData.join('; ')}</p>
          {/if}
          {#if entry.actions.length > 0}
            <p class={workMuted}>To qualify it:</p>
            <ul>
              {#each entry.actions as action}
                <li class={workMuted}>{action}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
      {#if engineDecision.omittedCandidates > 0}
        <p class={workMuted}>
          {engineDecision.omittedCandidates}
          further candidate(s) left out of this answer by its size bound.
        </p>
      {/if}
    </section>
  {/if}
  <form class={workRoutingForm} onsubmit={simulate}>
    {#if mode === 'live'}
      <p class={workMuted}>Local simulation from the read context, with optional preferences:</p>
    {/if}
    <label class={workMuted}
      >Review executor
      <select class={workInput} bind:value={forcedCandidateId}>
        <option value={null}>Use the recommendation</option>
        {#each candidates as candidate (candidate.id)}
          <option value={candidate.id}>
            {harnessLabel(candidate.harness)}
            · {candidate.model ?? 'model unknown'} · {candidate.effort ?? 'effort unknown'} ·
            {candidate.accountScope ?? 'account unknown'}
          </option>
        {/each}
      </select>
    </label>
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
        {chosen ? `Chosen: ${harnessLabel(chosen.harness)}` : 'No eligible candidate'}
      </h3>
      {#if recommendation}
        <p class={workMuted}>
          {#if recommendation.kind === 'real'}
            Real recommendation: every required field is declared or observed now.
          {:else if recommendation.kind === 'conditional'}
            Conditional (missing: {recommendation.missing}). A conditional simulation never permits a launch.
          {:else}
            No eligible candidate.
          {/if}
        </p>
      {/if}
      <p class={workMuted}>Simulation reference time: {result.referenceTime}. No execution was started.</p>
      {#if chosen}
        <p class={workMuted}>
          Recommended executor: {harnessLabel(chosen.harness)} · account {chosen.accountScope ?? 'unknown'} · machine
          {chosen.machineLabel ?? chosen.machineId ?? 'unknown'}
          · model {chosen.model ?? 'unknown'} · effort
          {chosen.effort ?? 'unknown'}.
        </p>
      {/if}
      <ul>
        {#each result.reasons as reason}
          <li class={workMuted}>{reason}</li>
        {/each}
      </ul>
      {#if candidates.length === 0}
        <p class={workMuted}>
          No candidate could be qualified. Declarations, quota scopes or executor observations are missing.
        </p>
      {/if}
      {#if alternatives.length > 0}
        <h4 class={workHeading}>{chosen ? 'Alternatives excluded' : 'Candidates excluded'}</h4>
      {/if}
      {#each alternatives as evaluation (evaluation.candidateId)}
        {@const alternative = candidateById(evaluation.candidateId)}
        <div class={workPanel}>
          <h5 class={workHeading}>
            {alternative ? `${harnessLabel(alternative.harness)} · ${alternative.accountScope ?? 'account unknown'}` : evaluation.candidateId}:
            {evaluation.eligible ? 'Eligible, not preferred' : 'Excluded'}
          </h5>
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
  {#if mode !== 'live'}
    <p class={workMuted} data-work-launch="demo">{DEMO_EXECUTION_TEXT}</p>
  {:else if reviewTarget}
    {#if result || engineDecision}
      <div class={workPanel} data-work-launch={gate.kind}>
        <h4 class={workHeading}>Execution</h4>
        {#if gate.kind === 'open'}
          <div class={workRow}>
            <button class={workButton} disabled={launch.pending} onclick={startReview} type="button">
              {startReviewLabel(launchCandidate?.harness ?? 'claude-code')}
            </button>
          </div>
          <p class={workMuted}>
            {launchCandidate?.harness === 'codex' ? 'Runs Codex through its native app-server in a read-only sandbox' : 'Runs Claude Code in plan mode with read-only tools'}
            in {gate.checkoutPath}. Model {launchCandidate?.model ?? 'CLI default'} · effort
            {launchCandidate?.effort ?? 'CLI default'}. The engine rechecks the account, billing mode, declaration,
            fixed revision and recommendation before starting; a second click returns the same attempt.
          </p>
        {:else}
          <p class={workMuted}>Launch is not possible: {gate.reason}</p>
        {/if}
        {#if launch.message}
          <p class={workMuted} role="status">{launch.message}</p>
        {/if}
      </div>
    {/if}
    <WorkAttempts
      attempts={resolvedAttempts}
      pending={attemptsPending}
      {...(mode === 'live' ? { onRelease: releaseReservation, onStop: stopReview } : {})}
    />
  {/if}
  <details>
    <summary class={workHeading}>Candidate evidence ({candidates.length})</summary>
    {#each candidates as candidate (candidate.id)}
      <div class={workPanel}>
        <h3 class={workHeading}>
          {harnessLabel(candidate.harness)}
          · {candidate.accountScope ?? 'account unknown'}
          · {candidate.machineLabel ?? candidate.machineId ?? 'Machine unknown'}
        </h3>
        <p class={workMuted}>
          {`${candidate.evidence.source} · ${candidate.evidence.observedAt ?? 'at an unknown time'}.`}
        </p>
        <ul>
          {#each CANDIDATE_PROVENANCE_FIELDS as field (field)}
            <li class={workMuted}>
              {fieldLabel[field]}: {fieldValue(candidate, field)} · {provenanceLabel(candidate, field)}
            </li>
          {/each}
        </ul>
        {#if candidate.qualificationActions.length > 0}
          <p class={workMuted}>To qualify this candidate:</p>
          <ul>
            {#each candidate.qualificationActions as action}
              <li class={workMuted}>{action}</li>
            {/each}
          </ul>
        {/if}
        {#if candidate.quota}
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
      {#each projectWorkEvidence({ machineId: reviewTarget.machineId, harness: reviewTarget.harness, sessionId: reviewTarget.sourceSessionId }, demoWorkEvidence(reviewTarget)) as interpretation}
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
