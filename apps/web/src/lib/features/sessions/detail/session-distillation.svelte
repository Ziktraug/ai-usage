<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits boolean aria-expanded values for the evidence buttons -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const stack = css({ display: 'grid', gap: '16px', minW: 0 });
  const controls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
  const assertionStyle = css({ display: 'grid', gap: '6px', overflowWrap: 'anywhere' });
  const meta = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6 });
  const prose = css({ fontSize: '13px', lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
  const episodeStyle = css({ display: 'grid', gap: '16px', borderTopWidth: '1px', borderColor: 'line', pt: '16px' });
  const heading = css({ fontSize: '14px', fontWeight: 600 });
  const evidenceStyle = css({ display: 'grid', gap: '8px', borderLeftWidth: '2px', borderColor: 'accent', pl: '12px' });
  const selectStyle = css({
    bg: 'surface',
    color: 'ink',
    borderWidth: '1px',
    borderColor: 'line',
    borderRadius: 'sm',
    p: '6px',
    maxW: 'full',
  });
</script>

<script lang="ts">
  import { ghostButton, muted } from '@ai-usage/design-system/svelte';
  import type {
    AssertionBasis,
    DistillationSelection,
    DistillationStatus,
    EpisodeOutcome,
    SourcedAssertion,
  } from '@ai-usage/web-contract/session-distillation';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { fmtDate, fmtNum } from '../../../foundation/presentation/format';
  import {
    sessionDistillationEvidenceKey,
    sessionDistillationEvidenceOptions,
    sessionDistillationGetOptions,
    sessionDistillationStatusOptions,
  } from '../../../query/options/session-distillation';
  import { useWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createSessionDistillationClient } from '../../../rpc/session-distillation-client';

  let { active, selection }: { active: boolean; selection: DistillationSelection } = $props();
  const context = useWebQueryRpcContext();
  const browser = typeof window !== 'undefined';
  const client = createSessionDistillationClient(context.rpc.sessionDistillation);
  const queryClient = useQueryClient();
  let selectedAnalysisId = $state<string | null>(null);
  let selectedEvidence = $state<{ key: string; eventId: string } | null>(null);
  const execution = $derived({ active, browser });
  const statusQuery = createQuery(() =>
    sessionDistillationStatusOptions(client, { kind: 'status', selection }, execution),
  );
  const analysisQuery = createQuery(() =>
    sessionDistillationGetOptions(
      client,
      selectedAnalysisId ? { kind: 'get', selection, analysisId: selectedAnalysisId } : undefined,
      execution,
    ),
  );
  const evidenceQuery = createQuery(() =>
    sessionDistillationEvidenceOptions(
      client,
      selectedAnalysisId && selectedEvidence
        ? { kind: 'evidence', selection, analysisId: selectedAnalysisId, eventIds: [selectedEvidence.eventId] }
        : undefined,
      execution,
    ),
  );
  const analysis = $derived(analysisQuery.data);
  const newerAvailable = $derived(
    statusQuery.data?.latest && selectedAnalysisId !== null && statusQuery.data.latest.id !== selectedAnalysisId,
  );

  $effect(() => {
    if (selectedAnalysisId === null && statusQuery.data?.latest) {
      selectedAnalysisId = statusQuery.data.latest.id;
    }
  });

  const basisLabels: Record<AssertionBasis, string> = {
    observed: 'Observed tool output',
    reported: 'Recorded statement',
    inferred: 'Interpretation',
    unknown: 'Not established',
  };
  const outcomeLabels: Record<EpisodeOutcome, string> = {
    'observed-success': 'Success observed',
    'reported-success': 'Success reported',
    failed: 'Failed',
    unresolved: 'Unresolved',
    abandoned: 'Abandoned',
    unknown: 'Outcome unknown',
  };
  const stateLabels: Record<DistillationStatus['state'], string> = {
    available: 'Analysis available',
    'not-analyzed': 'Not analyzed',
    queued: 'Analysis queued',
    running: 'Analysis in progress',
    failed: 'Analysis failed',
    cancelled: 'Analysis cancelled',
  };
  const chooseAnalysis = (id: string): void => {
    selectedEvidence = null;
    selectedAnalysisId = id;
  };
  const chooseLatest = (): void => {
    if (statusQuery.data?.latest) {
      chooseAnalysis(statusQuery.data.latest.id);
    }
  };
  const showEvidence = async (key: string, eventId: string): Promise<void> => {
    if (!selectedAnalysisId) {
      return;
    }
    if (selectedEvidence?.eventId === eventId) {
      selectedEvidence = { key, eventId };
      await evidenceQuery.refetch();
    } else {
      // Reopening a passage checks its original version again, even inside the cache's fresh window.
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: sessionDistillationEvidenceKey({
          kind: 'evidence',
          selection,
          analysisId: selectedAnalysisId,
          eventIds: [eventId],
        }),
        refetchType: 'none',
      });
      selectedEvidence = { key, eventId };
    }
  };
</script>

{#snippet assertion(_value: SourcedAssertion, _key: string)}
  <div class={assertionStyle}>
    <p class={prose}>{_value.text}</p>
    <div class={controls}>
      <span class={meta}>{basisLabels[_value.basis]}</span>
      {#each _value.evidence as ref, index (`${ref.eventId}:${index}`)}
        <button
          aria-expanded={selectedEvidence?.key === _key && selectedEvidence.eventId === ref.eventId}
          class={ghostButton}
          onclick={() => showEvidence(_key, ref.eventId)}
          type="button"
        >
          Evidence {index + 1}
        </button>
      {/each}
    </div>
    {#if selectedEvidence?.key === _key}
      <section aria-label="Selected evidence" class={evidenceStyle} data-session-analysis-evidence>
        {#if evidenceQuery.isFetching}
          <p class={meta} role="status">Checking the original source version…</p>
        {/if}
        {#if evidenceQuery.error}
          <p class={muted}>The source could not be checked. The analysis remains readable.</p>
          <button class={ghostButton} onclick={() => evidenceQuery.refetch()} type="button">Retry evidence</button>
        {:else if evidenceQuery.data?.status === 'changed'}
          <p class={muted}>
            Source changed. This analysis describes an earlier snapshot; the current text cannot be shown as its
            evidence.
          </p>
        {:else if evidenceQuery.data?.status === 'unavailable'}
          <p class={muted}>Source unavailable. The original passage cannot be read on this machine.</p>
        {:else if evidenceQuery.data?.status === 'available' && !evidenceQuery.isFetching}
          {#each evidenceQuery.data.events as evidenceEvent (evidenceEvent.id)}
            <p class={meta}>
              {evidenceEvent.kind}{evidenceEvent.toolName ? ` · ${evidenceEvent.toolName}` : ''}
              {evidenceEvent.timestamp ? ` · ${fmtDate(evidenceEvent.timestamp)}` : ''}
            </p>
            <pre class={prose}>{evidenceEvent.text}</pre>
            {#if evidenceEvent.truncated || evidenceEvent.redacted}
              <p class={meta}>
                {evidenceEvent.truncated ? 'Passage truncated. ' : ''}
                {evidenceEvent.redacted ? 'Sensitive patterns masked.' : ''}
              </p>
            {/if}
          {/each}
          <button class={ghostButton} onclick={() => evidenceQuery.refetch()} type="button">Recheck source</button>
        {/if}
        <button class={ghostButton} onclick={() => { selectedEvidence = null; }} type="button">Close evidence</button>
      </section>
    {/if}
  </div>
{/snippet}

{#snippet claims(_label: string, _values: SourcedAssertion[], _key: string)}
  {#if _values.length > 0}
    <section class={stack}>
      <h4 class={heading}>{_label}</h4>
      {#each _values as value, index (`${_key}:${index}`)}
        {@render assertion(value, `${_key}:${index}`)}
      {/each}
    </section>
  {/if}
{/snippet}

<section aria-label="Session account" class={stack} data-session-distillation>
  <div class={controls}>
    <h2 class={heading}>{statusQuery.data ? stateLabels[statusQuery.data.state] : 'Session analysis'}</h2>
    <button class={ghostButton} disabled={statusQuery.isFetching} onclick={() => statusQuery.refetch()} type="button">
      Refresh analysis status
    </button>
  </div>
  {#if statusQuery.isFetching && !statusQuery.data}
    <p class={meta} role="status">Reading analysis status…</p>
  {/if}
  {#if statusQuery.error}
    <p class={muted}>
      Analysis status is unavailable. This view requires the local Memory service and an authorized local Codex session.
    </p>
  {/if}
  {#if statusQuery.data?.state === 'not-analyzed'}
    <p class={prose}>This session has not been analyzed. Use the local distillation workflow to generate an account.</p>
  {:else if statusQuery.data?.state === 'failed' && analysis}
    <p class={meta}>The latest attempt failed. The selected earlier analysis remains available.</p>
  {/if}
  {#if statusQuery.data?.job?.errorCode}
    <p class={meta}>Processing result: {statusQuery.data.job.errorCode}</p>
  {/if}
  {#if newerAvailable && statusQuery.data?.latest}
    <button class={ghostButton} onclick={chooseLatest} type="button">Read the latest analysis</button>
  {/if}
  {#if statusQuery.data && statusQuery.data.revisions.length > 1}
    <label class={meta}>
      Analysis revision
      <select
        class={selectStyle}
        onchange={(event) => chooseAnalysis(event.currentTarget.value)}
        value={selectedAnalysisId ?? ''}
      >
        {#each statusQuery.data.revisions as revision (revision.id)}
          <option value={revision.id}>Revision {revision.revision} · {fmtDate(revision.createdAt)}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if statusQuery.data?.revisionsOmitted}
    <p class={meta}>{fmtNum(statusQuery.data.revisionsOmitted)} older revisions are omitted from this list.</p>
  {/if}
  {#if analysisQuery.isFetching && !analysis}
    <p class={meta} role="status">Reading the selected analysis…</p>
  {/if}
  {#if analysisQuery.error}
    <p class={muted}>The selected analysis could not be read safely.</p>
    <button class={ghostButton} onclick={() => analysisQuery.refetch()} type="button">Retry analysis read</button>
  {/if}
  {#if analysis}
    <p class={meta}>Analysis revision {analysis.revision} · {fmtDate(analysis.createdAt)} · Generated interpretation</p>
    {@render assertion(analysis.content.summary, 'summary')}
    {#if analysis.content.abstention}
      <p class={prose}>{analysis.content.abstention}</p>
    {/if}
    <details>
      <summary class={meta}>
        {analysis.coverage.status === 'partial' ? 'Partial source' : 'Source coverage'}
        · {fmtNum(analysis.coverage.includedEvents)} events · This session only
      </summary>
      <div class={stack}>
        <p class={meta}>
          Child sessions were not analyzed. Child discovery was not performed; this account does not cover the campaign.
        </p>
        <p class={meta}>Recorded session completion: {analysis.coverage.completion}.</p>
        {#if analysis.coverage.childrenNotAnalyzed !== null}
          <p class={meta}>{fmtNum(analysis.coverage.childrenNotAnalyzed)} known child sessions were excluded.</p>
        {/if}
        {#each analysis.coverage.exclusions as exclusion (exclusion.reason)}
          <p class={meta}>{exclusion.reason}: {fmtNum(exclusion.count)} excluded</p>
        {/each}
        <p class={meta}>
          Schema {analysis.schemaVersion} · normalization {analysis.normalizationVersion} · {analysis.extractorVersion}
        </p>
        <p class={meta}>
          Schema and references were validated. The meaning of each claim still needs to be checked against its
          evidence.
        </p>
        <p class={meta}>
          Evidence is checked against the analyzed source version when opened. Historical entry points may have changed.
        </p>
      </div>
    </details>
    {#each analysis.content.episodes as episode, index (episode.id)}
      <article class={episodeStyle} data-session-analysis-episode={episode.id}>
        <h3 class={heading}>Episode {index + 1} · {outcomeLabels[episode.result.status]}</h3>
        {@render assertion(episode.objective, `${episode.id}:objective`)}
        {@render claims('Attempts and observations', episode.attempts, `${episode.id}:attempt`)}
        <section class={stack}>
          <h4 class={heading}>Result</h4>
          {@render assertion(episode.result.assertion, `${episode.id}:result`)}
        </section>
        {@render claims('Difficulties', episode.difficulties, `${episode.id}:difficulty`)}
        {@render claims('Decisions', episode.decisions, `${episode.id}:decision`)}
        {@render claims('Historical entry points', episode.entryPoints, `${episode.id}:entry`)}
        {@render claims('Open questions', episode.openQuestions, `${episode.id}:question`)}
      </article>
    {/each}
  {/if}
</section>
