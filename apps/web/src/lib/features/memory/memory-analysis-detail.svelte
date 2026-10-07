<script lang="ts">
  import type { SourcedAssertion } from '@ai-usage/web-contract/session-distillation';
  import { createQuery } from '@tanstack/svelte-query';
  import { browser } from '$app/environment';
  import { finiteSwrKey } from '../../query/keys';
  import { sessionDistillationGetOptions } from '../../query/options/session-distillation';
  import { webQueryPolicies } from '../../query/policies';
  import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createSessionDistillationClient } from '../../rpc/session-distillation-client';
  import AnalysisAccount from '../sessions/detail/analysis-account.svelte';
  import { memoryAnalysisError } from './memory-errors';
  import MemoryPromotion from './memory-promotion.svelte';
  import { memoryButton, memoryCopy, memoryHeading, memoryPanel, memoryRow, memoryStack } from './memory-styles';
  import { memoryHref } from './memory-url';

  let {
    analysisId,
    projectId,
    projectName,
    episodeId = null,
    elementKey = null,
    address,
  }: {
    analysisId: string;
    projectId: string;
    projectName: string;
    episodeId?: string | null;
    elementKey?: string | null;
    address: string;
  } = $props();
  const client = createSessionDistillationClient(useWebQueryRpcContext().rpc.sessionDistillation);
  const rpc = useWebQueryRpcContext().rpc.sessionDistillation;
  let historyOpen = $state(false);
  let historyCursor = $state<string | null>(null);
  const historyQuery = createQuery(() => ({
    ...webQueryPolicies.finiteSwr,
    enabled: browser && historyOpen,
    queryKey: finiteSwrKey('memory', 'analysis-history', analysisId, historyCursor ?? ''),
    queryFn: ({ signal }) =>
      rpc.history({ kind: 'history', analysisId, projectId, limit: 20, cursor: historyCursor }, { signal }),
  }));
  const query = createQuery(() =>
    sessionDistillationGetOptions(client, { kind: 'get', projectId, analysisId }, { active: true, browser }),
  );
  let promotion = $state<{ key: string; assertion: SourcedAssertion } | null>(null);
  $effect(() => {
    if (!((episodeId || elementKey) && query.data && browser)) {
      return;
    }
    requestAnimationFrame(() =>
      document
        .getElementById(elementKey ? `analysis-element-${encodeURIComponent(elementKey)}` : `episode-${episodeId}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  });
</script>
<aside aria-label="Analysis reading panel" class={`${memoryPanel} analysis-reader`} data-memory-analysis-detail>
  <div class={memoryRow}>
    <h2 class={memoryHeading}>Session account</h2>
    <a
      class={memoryButton}
      data-sveltekit-noscroll
      href={memoryHref(address,{analysis:null,analysisProject:null,episode:null,element:null})}
      >Close account</a
    >
  </div>
  {#if query.isPending}
    <p class={memoryCopy} role="status">Reading the saved revision…</p>
  {:else if query.error}
    <p class={memoryCopy} role="alert">
      {memoryAnalysisError(query.error,'This saved analysis could not be read. It may have been withdrawn or its access may have changed.')}
    </p>
    <button class={memoryButton} onclick={()=>query.refetch()} type="button">Retry saved account</button>
  {:else if query.data}
    <p class={memoryCopy}>{projectName} · Generated account, separate from accepted guidance.</p>
    <details ontoggle={(event)=>{historyOpen=event.currentTarget.open;}}>
      <summary class={memoryCopy}>Analysis revision history</summary>
      {#if historyQuery.data}
        <nav aria-label="Saved analysis revisions" class={memoryRow}>
          {#each historyQuery.data.items as revision (revision.id)}
            <a
              class={memoryButton}
              data-sveltekit-noscroll
              href={memoryHref(address,{analysis:revision.id,episode:null})}
              >Revision {revision.revision} · {new Date(revision.createdAt).toLocaleDateString()}</a
            >
          {/each}
        </nav>
        {#if historyQuery.data.nextCursor}
          <button
            class={memoryButton}
            onclick={()=>{historyCursor=historyQuery.data?.nextCursor ?? null;}}
            type="button"
          >
            Older revisions
          </button>
        {/if}
      {:else if historyQuery.error}
        <p class={memoryCopy}>Analysis history could not be read.</p>
      {:else if historyOpen}
        <p class={memoryCopy} role="status">Reading revision history…</p>
      {/if}
    </details>
    {#if query.data.content.episodes.length>0}
      <nav aria-label="Analysis episodes" class={memoryRow}>
        {#each query.data.content.episodes as episode, index (episode.id)}
          <a class={memoryButton} data-sveltekit-noscroll href={memoryHref(address,{episode:episode.id})}
            >Episode {index+1}</a
          >
        {/each}
      </nav>
    {/if}
    <AnalysisAccount analysis={query.data} {episodeId} onPromote={(key,assertion)=>{promotion={key,assertion};}} />
    {#if promotion}
      <MemoryPromotion
        analysis={query.data}
        assertion={promotion.assertion}
        elementKey={promotion.key}
        onClose={()=>{promotion=null;}}
        {projectName}
      />
    {/if}
    <details class={memoryStack}>
      <summary class={memoryCopy}>Source session and provenance</summary>
      <p class={memoryCopy}>
        Analysis revision {query.data.revision} remains accessible through this link independently of the temporary
        usage report. Evidence is rechecked against the recorded snapshot.
      </p>
      {#if query.data.source.reportAnchor}
        <a
          href={`/sessions/${encodeURIComponent(query.data.source.reportAnchor.rowId)}?revision=${encodeURIComponent(query.data.source.reportAnchor.revision)}`}
          >Open source session</a
        >
        <p class={memoryCopy}>
          The source session link requires its retained usage report and may expire. This saved account does not.
        </p>
      {/if}
      <p class={memoryCopy}>
        {query.data.extractorVersion}
        · {query.data.validation} · Generated {new Date(query.data.createdAt).toLocaleString()}
      </p>
    </details>
  {/if}
</aside>

<style>
  /* Keep detail-only geometry with the lazy reader instead of the report's global CSS. */
  .analysis-reader {
    top: 16px;
    align-self: start;
  }

  @media screen and (width >= 64rem) {
    .analysis-reader {
      position: sticky;
      max-height: calc(100vh - 160px);
      overflow-y: auto;
    }
  }
</style>
