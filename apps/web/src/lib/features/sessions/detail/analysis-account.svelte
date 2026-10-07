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
</script>

<script lang="ts">
  import { ghostButton, muted } from '@ai-usage/design-system/svelte';
  import type {
    AssertionBasis,
    EpisodeOutcome,
    SessionAnalysis,
    SourcedAssertion,
  } from '@ai-usage/web-contract/session-distillation';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { fmtDate, fmtNum } from '../../../foundation/presentation/format';
  import {
    sessionDistillationEvidenceKey,
    sessionDistillationEvidenceOptions,
  } from '../../../query/options/session-distillation';
  import { useWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createSessionDistillationClient } from '../../../rpc/session-distillation-client';

  let {
    analysis,
    onPromote,
    episodeId = null,
  }: {
    analysis: SessionAnalysis;
    onPromote?: (key: string, assertion: SourcedAssertion) => void;
    episodeId?: string | null;
  } = $props();
  const client = createSessionDistillationClient(useWebQueryRpcContext().rpc.sessionDistillation);
  const queryClient = useQueryClient();
  let selectedEvidence = $state<{ key: string; eventId: string } | null>(null);
  const evidenceInput = $derived(
    selectedEvidence
      ? {
          kind: 'evidence' as const,
          projectId: analysis.projectId,
          analysisId: analysis.id,
          identity: { packetDigest: analysis.packetDigest, sourceDigest: analysis.source.version.digest },
          eventIds: [selectedEvidence.eventId],
        }
      : undefined,
  );
  const evidenceQuery = createQuery(() =>
    sessionDistillationEvidenceOptions(client, evidenceInput, { active: true, browser: typeof window !== 'undefined' }),
  );
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
  const showEvidence = async (key: string, eventId: string): Promise<void> => {
    if (selectedEvidence?.eventId === eventId) {
      selectedEvidence = { key, eventId };
      await evidenceQuery.refetch();
      return;
    }
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: sessionDistillationEvidenceKey({
        kind: 'evidence',
        projectId: analysis.projectId,
        analysisId: analysis.id,
        identity: { packetDigest: analysis.packetDigest, sourceDigest: analysis.source.version.digest },
        eventIds: [eventId],
      }),
      refetchType: 'none',
    });
    selectedEvidence = { key, eventId };
  };
</script>
{#snippet assertion(_value: SourcedAssertion, _key: string)}
  <div class={assertionStyle} id={`analysis-element-${encodeURIComponent(_key)}`}>
    <p class={prose}>{_value.text}</p>
    <div class={controls}>
      {#if onPromote && (_key === 'summary' || _key.endsWith(':result') || _key.includes(':decision:'))}
        <button class={ghostButton} onclick={() => onPromote?.(_key, _value)} type="button">
          Propose as knowledge
        </button>
      {/if}
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
        <p class={meta}>Quotation retained from this analysis snapshot</p>
        {#each _value.evidence.filter((ref) => ref.eventId === selectedEvidence?.eventId) as ref}
          <blockquote class={prose}>{ref.quote}</blockquote>
        {/each}
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
        {:else if evidenceQuery.data?.status === 'denied'}
          <p class={muted}>Access to this source is denied. The retained historical quotation remains readable.</p>
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

<section aria-label="Saved session account" class={stack}>
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
        Schema and references were validated. The meaning of each claim still needs to be checked against its evidence.
      </p>
      <p class={meta}>
        Evidence is checked against the analyzed source version when opened. Historical entry points may have changed.
      </p>
    </div>
  </details>
  {#each analysis.content.episodes as episode, index (episode.id)}
    <article class={episodeStyle} data-session-analysis-episode={episode.id} id={`episode-${episode.id}`} tabindex="-1">
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
</section>
