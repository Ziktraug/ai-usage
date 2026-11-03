<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import type { SessionEvidenceRecord, SessionEvidenceResponse } from '@ai-usage/report-core/session-evidence';
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';
  import { browser } from '$app/env';
  import { sessionEvidenceQueryOptions } from '../../query/options/session-evidence';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';

  let { rowId, revision, synthetic = false }: { rowId: string; revision: string; synthetic?: boolean } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  let requested = $state(false);
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });
  const sample = (): Promise<SessionEvidenceResponse> =>
    Promise.resolve({
      status: 'available',
      revision,
      evidence: {
        sourceSessionId: 'synthetic-session',
        coverage: { partial: false, omittedRecords: 0, unattributedRecords: 0 },
        records: [
          {
            id: 'synthetic-response',
            at: '2026-11-01T10:00:00.000Z',
            kind: 'response',
            text: 'Synthetic recorded response: the parser now rejects an invalid date.',
            toolName: null,
            callId: null,
            turnIndex: 0,
            promptIds: ['synthetic-prompt'],
            truncated: false,
          },
        ],
      },
    });
  const query = createQuery(() =>
    sessionEvidenceQueryOptions(
      synthetic
        ? { evidence: sample }
        : (rpc?.session ?? ssrUnavailableClient<NonNullable<typeof rpc>['session']>('recorded results')),
      { rowId, revision },
      browser && requested,
    ),
  );
  const evidence = $derived(query.data?.status === 'available' ? query.data.evidence : null);
  const labels: Record<SessionEvidenceRecord['kind'], string> = {
    response: 'Recorded response',
    command: 'Command request',
    patch: 'Patch request',
    'tool-call': 'Tool call',
    'tool-result': 'Recorded tool output',
  };
  const muted = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6 });
  const content = css({
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: '12px',
    lineHeight: 1.6,
    maxH: '320px',
    overflow: 'auto',
    p: '12px',
    bg: 'surface',
    borderRadius: 'sm',
  });
  const container = css({ display: 'grid', gap: '12px', minW: 0 });
</script>
<div class={container}>
  {#if !requested}
    <button
      class={ghostButton}
      disabled={!mounted}
      onclick={() => {
        requested = true;
      }}
      type="button"
    >
      Read recorded results
    </button>
  {:else}
    <p class={muted}>
      Native response and tool records from this session only. Requests are not proof of execution, applied changes,
      test success, or a merged pull request. Child sessions retain their own traces.
    </p>
    {#if synthetic}
      <p class={muted}>Synthetic example results. No local history is read.</p>
    {/if}
    {#if query.isFetching}
      <p role="status">Reading recorded results…</p>
    {/if}
    {#if query.isError}
      <p role="alert">Recorded results could not be read. {query.error.message}</p>
      <button class={ghostButton} onclick={() => query.refetch()} type="button">Retry recorded results</button>
    {/if}
    {#if query.data?.status === 'unavailable'}
      <p role="status">{query.data.message}</p>
    {/if}
    {#if evidence}
      <p class={muted}>
        {evidence.records.length}
        records · {evidence.coverage.omittedRecords} omitted · {evidence.coverage.unattributedRecords} without canonical
        turn attribution.
        {evidence.coverage.partial
          ? 'Partial recorded evidence.'
          : 'All supported evidence within the available native read.'}
        Limit: 200 records, 8,000 characters per record, 256,000 characters total.
      </p>
      {#if evidence.records.length === 0}
        <p class={muted}>No supported response or tool records were available in this native read.</p>
      {/if}
      {#each evidence.records as record, index (`${record.id}:${index}`)}
        <details>
          <summary>
            {labels[record.kind]}{record.toolName ? ` · ${record.toolName}` : ''}
            · {record.turnIndex === null ? 'Turn unattributed' : `Canonical turn ${record.turnIndex + 1}`}
          </summary>
          <p class={muted}>
            {record.at}
            · source {evidence.sourceSessionId}{record.callId ? ` · call ${record.callId}` : ''}{record.truncated
              ? ' · truncated excerpt'
              : ''}
          </p>
          <pre class={content}>{record.text}</pre>
        </details>
      {/each}
    {/if}
  {/if}
</div>
