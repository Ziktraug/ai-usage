<script lang="ts">
  import type {
    DelegationJobsOutput,
    DelegationJobViewWire,
    DelegationRecordAcceptanceInput,
  } from '@ai-usage/web-contract/delegation';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/env';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { createDelegationMutations, delegationJobsQueryOptions } from '../../query/options/delegation';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import {
    createDelegationClient,
    type DelegationClient,
    type DelegationClientResult,
  } from '../../rpc/delegation-client';
  import { formatExactInstant, formatRelativeAge } from './work-attention-model';
  import {
    ACCEPTANCE_ACTIONS,
    acceptanceOutcome,
    acceptedLabel,
    CANCEL_DELEGATION_LABEL,
    cancelOutcome,
    coverageText,
    DEMO_DELEGATION_TEXT,
    type DelegationActionOutcome,
    delegationStateLabel,
    EMPTY_DELEGATION_TEXT,
    evaluationLine,
    evidenceText,
    executedLabel,
    executedScopeText,
    frozenScopeText,
    guaranteeText,
    isEndedDelegationState,
    refusalOrFailureText,
    routeLine,
    scopeLine,
    selectionText,
    shortJobId,
    truncationText,
    usageLine,
    verifiedLabel,
    WORK_DELEGATIONS_LIMIT,
  } from './work-delegations-model';
  import {
    workButton,
    workExcerpt,
    workFactList,
    workHeading,
    workInput,
    workMuted,
    workPanel,
    workRow,
    workStack,
    workSubsectionTitle,
  } from './work-styles';

  let {
    jobs,
    mode,
    onAcceptance,
    onCancel,
    reference,
  }: {
    /**
     * The jobs result. Omit it and the component reads the recent jobs itself in live mode; pass a
     * result to render it, or `null` to state that the jobs are unavailable.
     */
    jobs?: DelegationClientResult<DelegationJobsOutput> | null;
    mode: RuntimeMode;
    /** Records the operator's acceptance; omit it to use the engine through the RPC client. */
    onAcceptance?: (input: DelegationRecordAcceptanceInput) => Promise<DelegationActionOutcome>;
    /** Asks the engine to cancel a live job; omit it to use the RPC client. */
    onCancel?: (jobId: string) => Promise<DelegationActionOutcome>;
    /** The instant relative ages are measured from; defaults to now. */
    reference?: string;
  } = $props();

  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const queryClient = useQueryClient();
  const client = untrack(() =>
    browser && rpc
      ? createDelegationClient(rpc.delegation)
      : ({
          cancel: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
          job: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
          jobs: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
          recordAcceptance: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
          saveSettings: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
          settings: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
          simulate: () => Promise.reject(new Error('The delegation RPC client is unavailable during SSR.')),
        } satisfies DelegationClient),
  );
  const mutations = untrack(() => createDelegationMutations(queryClient, client));
  const query = createQuery(() =>
    delegationJobsQueryOptions(
      client,
      { limit: WORK_DELEGATIONS_LIMIT },
      { browser, enabled: mode === 'live' && jobs === undefined },
    ),
  );
  const resolved = $derived.by<DelegationClientResult<DelegationJobsOutput> | null>(() => {
    if (jobs !== undefined) {
      return jobs;
    }
    if (query.data) {
      return query.data;
    }
    // A transport failure carries no safe detail for the page; the tag is enough to act on.
    return query.error ? { error: { message: 'The request did not complete.', tag: 'Unavailable' }, ok: false } : null;
  });
  const pending = $derived(jobs === undefined && mode === 'live' && query.isPending);
  const referenceTime = $derived(reference ?? (resolved === null ? '' : new Date().toISOString()));
  const when = (instant: string): string =>
    `${formatRelativeAge(instant, referenceTime)} (${formatExactInstant(instant)})`;

  let actions = $state<Record<string, { readonly outcome: DelegationActionOutcome | null; readonly pending: boolean }>>(
    {},
  );
  let notes = $state<Record<string, string>>({});
  const run = async (jobId: string, action: () => Promise<DelegationActionOutcome>): Promise<void> => {
    if (actions[jobId]?.pending) {
      return;
    }
    actions = { ...actions, [jobId]: { outcome: null, pending: true } };
    const outcome = await action();
    actions = { ...actions, [jobId]: { outcome, pending: false } };
  };
  const cancel = (jobId: string): Promise<void> =>
    run(jobId, () => (onCancel ? onCancel(jobId) : mutations.cancel({ jobId }).then(cancelOutcome)));
  const accept = (job: DelegationJobViewWire, verdict: DelegationRecordAcceptanceInput['verdict']): Promise<void> => {
    const note = notes[job.jobId]?.trim() ?? '';
    const input: DelegationRecordAcceptanceInput = {
      jobId: job.jobId,
      verdict,
      ...(note.length === 0 ? {} : { note }),
    };
    return run(job.jobId, () =>
      onAcceptance
        ? onAcceptance(input)
        : mutations.recordAcceptance(input).then((result) => acceptanceOutcome(result, verdict)),
    );
  };
</script>

<section aria-labelledby="work-delegations-heading" class={workStack} data-work-delegations>
  <h2 class={workHeading} id="work-delegations-heading">Delegations</h2>
  {#if mode === 'demo'}
    <p class={workMuted}>{DEMO_DELEGATION_TEXT}</p>
  {:else if pending}
    <p class={workMuted} role="status">Reading delegations…</p>
  {:else if resolved === null}
    <p class={workMuted} role="status">Delegations are unavailable.</p>
  {:else if !resolved.ok}
    <p class={workMuted} role="status">Delegations unavailable ({resolved.error.tag}: {resolved.error.message}).</p>
  {:else if resolved.data.jobs.length === 0}
    <p class={workMuted}>{EMPTY_DELEGATION_TEXT}</p>
  {:else}
    <p class={workMuted}>
      Read-only reviews handed to AI Usage by an MCP client or the CLI; the Web starts none. Execution, verification and
      acceptance are three different facts.
    </p>
    <ul class={workFactList}>
      {#each resolved.data.jobs as job (job.jobId)}
        {@const ended = isEndedDelegationState(job.state)}
        {@const problem = refusalOrFailureText(job)}
        {@const action = actions[job.jobId]}
        {@const cut = truncationText(job.truncation)}
        <li class={workPanel} data-work-delegation={job.jobId} data-work-delegation-state={job.state}>
          <p class={workHeading}>
            {delegationStateLabel(job.state)}
            · delegation {shortJobId(job.jobId)} · {job.request.taskCategory}
          </p>
          <p class={workMuted} data-work-delegation-route>{routeLine(job.route)}</p>
          <p class={workMuted}>
            Checkout {job.request.checkoutPath} · {scopeLine(job.request.scope)} · attempt
            {job.attemptNumber}{job.retryOf ? ` (retries ${shortJobId(job.retryOf)})` : ''}.
          </p>
          <p class={workMuted} data-work-delegation-frozen-scope>{frozenScopeText(job.frozenScope)}</p>
          <p class={workMuted}>Objective: {job.request.objective}</p>
          <p class={workMuted}>
            Requested {when(job.requestedAt)}{job.startedAt ? ` · started ${when(job.startedAt)}` : ''}{job.endedAt
              ? ` · ended ${when(job.endedAt)}`
              : ''}{job.live && job.heartbeatAgeSeconds !== null
              ? ` · last heartbeat ${job.heartbeatAgeSeconds} s ago`
              : ''}{job.cancelRequestedAt ? ` · cancel requested ${when(job.cancelRequestedAt)}` : ''}.
          </p>
          {#if problem}
            <p class={workMuted} data-work-delegation-problem>{problem}</p>
          {/if}
          {#if job.state === 'lost'}
            <p class={workMuted}>
              {job.reservation.held
                ? 'Its reservation is held until release evidence is recorded; the engine never relaunches a job.'
                : `Its reservation was released (${job.reservation.evidence ?? 'evidence recorded'}).`}
            </p>
          {/if}
          <p class={workMuted} data-work-delegation-fact="executed">Executed: {executedLabel(job.status.executed)}.</p>
          <p class={workMuted} data-work-delegation-fact="verified">
            Verified: {verifiedLabel(job.status.verified)} ({job.evaluations.verifications.length}
            by the calling model,
            {job.evaluations.automatedChecks.length}
            automated check{job.evaluations.automatedChecks.length === 1 ? '' : 's'}).
          </p>
          <p class={workMuted} data-work-delegation-fact="accepted">
            Accepted: {acceptedLabel(job.status.accepted)}{job.evaluations.acceptance
              ? ` (recorded ${when(job.evaluations.acceptance.recordedAt)})`
              : ''}.
          </p>
          <details class={workPanel} data-work-delegation-detail>
            <summary class={workMuted}>Decision, result, guarantee and usage</summary>
            <div class={workStack}>
              <h3 class={workSubsectionTitle}>Decision</h3>
              {#if job.qualification}
                <p class={workMuted}>
                  Qualification {job.qualification.qualificationId} · policy revision
                  {job.qualification.policyRevision ?? 'unknown'}
                  · catalog revision
                  {job.qualification.catalogRevision ?? 'unknown'}
                  · {job.qualification.admissibleRoutes} admissible route{job.qualification.admissibleRoutes === 1
                    ? ''
                    : 's'}{job.qualification.qualifiedAt ? ` · qualified ${when(job.qualification.qualifiedAt)}` : ''}.
                </p>
                {#if job.qualification.excludedRoutes.length > 0}
                  <p class={workMuted}>Excluded routes and their blockers:</p>
                  <ul class={workFactList}>
                    {#each job.qualification.excludedRoutes as excluded (excluded.routeId)}
                      <li class={workMuted}>
                        {excluded.routeId}:
                        {excluded.blockers.length === 0 ? 'no blocker named' : excluded.blockers.join(', ')}
                      </li>
                    {/each}
                  </ul>
                  {#if job.qualification.omittedExcludedRoutes > 0}
                    <p class={workMuted}>
                      {job.qualification.omittedExcludedRoutes}
                      more excluded route(s) are not listed in this view.
                    </p>
                  {/if}
                {:else}
                  <p class={workMuted}>No route was excluded.</p>
                {/if}
              {:else}
                <p class={workMuted}>No qualification recorded for this job.</p>
              {/if}
              <p class={workMuted} data-work-delegation-selection>{selectionText(job.selection)}</p>

              <h3 class={workSubsectionTitle}>Result</h3>
              {#if job.result}
                <p class={workMuted}>Result kind: {job.result.kind}.</p>
                {#if job.result.summary}
                  <p class={workMuted} data-work-delegation-summary>{job.result.summary}</p>
                {/if}
                {#if job.result.findings.length > 0}
                  <ul class={workFactList}>
                    {#each job.result.findings as finding, index (index)}
                      <li class={workMuted} data-work-delegation-finding={finding.severity}>
                        {finding.severity}: {finding.title} — {finding.detail} ({evidenceText(finding.evidence)})
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class={workMuted}>No finding.</p>
                {/if}
                <p class={workMuted}>{coverageText(job.result.coverage)}</p>
                {#if job.result.checks.length > 0}
                  <p class={workMuted}>Checks the worker stated: {job.result.checks.join('; ')}.</p>
                {/if}
                {#if job.result.limits.length > 0}
                  <p class={workMuted}>Limits the worker stated: {job.result.limits.join('; ')}.</p>
                {/if}
                {#if job.result.excerpt}
                  <pre class={workExcerpt} data-work-delegation-excerpt>{job.result.excerpt}</pre>
                {/if}
              {:else}
                <p class={workMuted}>No result recorded.</p>
              {/if}
              {#if job.executedScope}
                <p class={workMuted}>{executedScopeText(job.executedScope)}</p>
              {/if}
              {#if cut}
                <p class={workMuted} data-work-delegation-truncation>{cut}</p>
              {/if}

              <h3 class={workSubsectionTitle}>Guarantee</h3>
              <p class={workMuted} data-work-delegation-guarantee>
                {job.guarantee ? guaranteeText(job.guarantee) : 'No guarantee recorded: nothing was launched.'}
              </p>

              <h3 class={workSubsectionTitle}>Usage</h3>
              <p class={workMuted}>{usageLine(job.usage)}</p>

              <h3 class={workSubsectionTitle}>Verifications and acceptances</h3>
              {#if job.evaluations.automatedChecks.length +
                job.evaluations.verifications.length +
                job.evaluations.acceptances.length ===
                0}
                <p class={workMuted}>None recorded.</p>
              {:else}
                <ul class={workFactList}>
                  {#each job.evaluations.automatedChecks as evaluation (evaluation.evaluationId)}
                    <li class={workMuted}>
                      Automated check: {evaluationLine(evaluation, when(evaluation.recordedAt))}
                    </li>
                  {/each}
                  {#each job.evaluations.verifications as evaluation (evaluation.evaluationId)}
                    <li class={workMuted}>Verification: {evaluationLine(evaluation, when(evaluation.recordedAt))}</li>
                  {/each}
                  {#each job.evaluations.acceptances as evaluation (evaluation.evaluationId)}
                    <li class={workMuted}>Acceptance: {evaluationLine(evaluation, when(evaluation.recordedAt))}</li>
                  {/each}
                </ul>
              {/if}
              {#each job.notes as note, index (index)}
                <p class={workMuted}>{note}</p>
              {/each}
            </div>
          </details>
          {#if job.live}
            <div class={workRow}>
              <button
                class={workButton}
                data-work-delegation-cancel={job.jobId}
                disabled={action?.pending === true}
                onclick={() => cancel(job.jobId)}
                type="button"
              >
                {CANCEL_DELEGATION_LABEL}
              </button>
            </div>
          {/if}
          {#if ended}
            <form
              aria-label="Your acceptance of delegation {shortJobId(job.jobId)}"
              class={workStack}
              data-work-delegation-acceptance={job.jobId}
              onsubmit={(event) => event.preventDefault()}
            >
              <p class={workMuted}>
                Your acceptance is recorded as the operator's, separately from the result and from any verification.
              </p>
              <label class={workMuted} for="work-delegation-note-{job.jobId}">Note (optional)</label>
              <input
                class={workInput}
                disabled={action?.pending === true}
                id="work-delegation-note-{job.jobId}"
                maxlength="2000"
                type="text"
                bind:value={notes[job.jobId]}
              >
              <div class={workRow}>
                {#each ACCEPTANCE_ACTIONS as item (item.verdict)}
                  <button
                    class={workButton}
                    data-work-delegation-verdict={item.verdict}
                    disabled={action?.pending === true}
                    onclick={() => accept(job, item.verdict)}
                    type="button"
                  >
                    {item.label}
                  </button>
                {/each}
              </div>
            </form>
          {/if}
          {#if action?.pending}
            <p class={workMuted} role="status">Recording…</p>
          {:else if action?.outcome}
            <p class={workMuted} role={action.outcome.failed ? 'alert' : 'status'}>{action.outcome.message}</p>
          {/if}
        </li>
      {/each}
    </ul>
    {#if resolved.data.skipped > 0}
      <p class={workMuted}>{resolved.data.skipped} stored job(s) refused on re-validation are not shown.</p>
    {/if}
    {#if resolved.data.omitted > 0}
      <p class={workMuted} data-work-delegations-omitted>
        {resolved.data.omitted}
        older job(s) not shown; the list stays under its size bound.
      </p>
    {/if}
  {/if}
</section>
