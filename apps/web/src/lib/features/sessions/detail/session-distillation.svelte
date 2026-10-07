<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits boolean aria-expanded values for the evidence buttons -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const stack = css({ display: 'grid', gap: '16px', minW: 0 });
  const controls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
  const meta = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6 });
  const prose = css({ fontSize: '13px', lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
  const heading = css({ fontSize: '14px', fontWeight: 600 });
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
  import type { DistillationSelection, DistillationStatus } from '@ai-usage/web-contract/session-distillation';
  import { createQuery } from '@tanstack/svelte-query';
  import { fmtDate, fmtNum } from '../../../foundation/presentation/format';
  import {
    sessionDistillationGetOptions,
    sessionDistillationStatusOptions,
  } from '../../../query/options/session-distillation';
  import { useWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createSessionDistillationClient } from '../../../rpc/session-distillation-client';
  import AnalysisAccount from './analysis-account.svelte';

  let { active, selection }: { active: boolean; selection: DistillationSelection } = $props();
  const context = useWebQueryRpcContext();
  const browser = typeof window !== 'undefined';
  const client = createSessionDistillationClient(context.rpc.sessionDistillation);
  let selectedAnalysisId = $state<string | null>(null);
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
  const analysis = $derived(analysisQuery.data);
  const newerAvailable = $derived(
    statusQuery.data?.latest && selectedAnalysisId !== null && statusQuery.data.latest.id !== selectedAnalysisId,
  );

  $effect(() => {
    if (selectedAnalysisId === null && statusQuery.data?.latest) {
      selectedAnalysisId = statusQuery.data.latest.id;
    }
  });

  const stateLabels: Record<DistillationStatus['state'], string> = {
    available: 'Analysis available',
    'not-analyzed': 'Not analyzed',
    queued: 'Analysis queued',
    running: 'Analysis in progress',
    failed: 'Analysis failed',
    cancelled: 'Analysis cancelled',
  };
  const chooseAnalysis = (id: string): void => {
    selectedAnalysisId = id;
  };
  const chooseLatest = (): void => {
    if (statusQuery.data?.latest) {
      chooseAnalysis(statusQuery.data.latest.id);
    }
  };
</script>

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
    <AnalysisAccount {analysis} />
  {/if}
</section>
