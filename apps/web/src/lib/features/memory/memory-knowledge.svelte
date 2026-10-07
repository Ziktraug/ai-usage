<script lang="ts">
  import type { MemoryContractClient, MemoryKnowledgeInput } from '@ai-usage/web-contract/memory';
  import type { SessionDistillationContractClient } from '@ai-usage/web-contract/session-distillation';
  import { createQuery } from '@tanstack/svelte-query';
  import { browser } from '$app/environment';
  import { immutableRevisionKey } from '../../query/keys';
  import { memoryKnowledgeOptions } from '../../query/options/memory-workspace';
  import { webQueryPolicies } from '../../query/policies';
  import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import MemorySearch from './memory-search.svelte';
  import {
    memoryButton,
    memoryCopy,
    memoryField,
    memoryHeading,
    memoryInput,
    memoryPanel,
    memoryRow,
    memoryStack,
  } from './memory-styles';

  let { projectId = null }: { projectId?: string | null } = $props();
  let kind = $state<MemoryKnowledgeInput['kind']>(null);
  let cursor = $state<string | null>(null);
  let searching = $state(false);
  const rpc = browser ? useWebQueryRpcContext().rpc.memory : ssrUnavailableClient<MemoryContractClient>('memory');
  const query = createQuery(() =>
    memoryKnowledgeOptions(rpc, { projectId, kind, cursor, pageSize: 20 }, browser && !searching),
  );
  let selected = $state<{ itemId: string; revisionId: string } | null>(null);
  const detail = createQuery(() => ({
    ...webQueryPolicies.immutableRevision,
    enabled: browser && selected !== null,
    queryKey: immutableRevisionKey('memory', selected?.revisionId ?? '', selected?.itemId ?? '', 'accepted-detail'),
    queryFn: ({ signal }) => {
      if (!selected) {
        throw new Error('Choose an accepted revision.');
      }
      return rpc.getKnowledge(selected, { signal });
    },
  }));
  const sourceLink = (value: unknown): string | null => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('sourceLocator' in value) ||
      typeof value.sourceLocator !== 'string' ||
      !value.sourceLocator.startsWith('/memory?')
    ) {
      return null;
    }
    return value.sourceLocator;
  };
</script>
<div class={memoryStack}>
  <label class={memoryField}
    >Knowledge type<select class={memoryInput} onchange={()=>{cursor=null;}} bind:value={kind}>
      <option value={null}>All types</option>
      {#each ['decision','pattern','pitfall','command','constraint','handoff','lesson','preference'] as value}
        <option {value}>{value}</option>
      {/each}
    </select></label
  >
  <MemorySearch {kind} onActiveChange={(active)=>{searching=active;}} {projectId} />
  {#if !searching}
    {#if query.isPending}
      <p class={memoryCopy} role="status">Reading accepted knowledge…</p>
    {:else if query.error}
      <p class={memoryCopy} role="alert">Accepted knowledge is temporarily unavailable. Check the Memory service.</p>
    {:else if query.data?.items.length===0}
      <section class={memoryPanel}>
        <h2 class={memoryHeading}>No accepted knowledge in this scope</h2>
        <p class={memoryCopy}>
          Session accounts remain readable in Analysed sessions. Propose a useful passage there, edit it, then
          explicitly accept it in Pending review to create your first knowledge.
        </p>
      </section>
    {:else if query.data}
      <p class={memoryCopy}>
        Accepted guidance can become outdated. Verify it against the current task and its evidence.
      </p>
      {#each query.data.items as item (item.revisionId)}
        <article class={memoryPanel}>
          <h2 class={memoryHeading}>{item.title}</h2>
          <p class={memoryCopy}>{item.summary}</p>
          <p class={memoryCopy}>
            {item.kind}
            · {item.trust} · {item.sensitivity} · Accepted revision {item.revisionNumber}
          </p>
          {#if item.guidance.length>0}
            <ul>
              {#each item.guidance as guidance}
                <li class={memoryCopy}>{guidance}</li>
              {/each}
            </ul>
          {/if}
          {#if item.contentOmitted}
            <button
              class={memoryButton}
              onclick={()=>{selected={itemId:item.id,revisionId:item.revisionId};}}
              type="button"
            >
              Read complete accepted revision
            </button>
          {/if}
          {#if selected?.revisionId===item.revisionId}
            {#if detail.data}
              <section aria-label="Complete accepted revision" class={memoryStack}>
                <p class={memoryCopy}>{detail.data.summary}</p>
                <ul>
                  {#each detail.data.guidance as guidance}
                    <li class={memoryCopy}>{guidance}</li>
                  {/each}
                </ul>
                <details>
                  <summary class={memoryCopy}>Retained structured evidence</summary>
                  <pre class={memoryCopy}>{JSON.stringify(detail.data.structuredContent,null,2)}</pre>
                </details>
              </section>
            {:else if detail.error}
              <p class={memoryCopy} role="alert">This revision could not be read safely.</p>
            {:else}
              <p class={memoryCopy} role="status">Reading the accepted revision…</p>
            {/if}
          {/if}
          {#if sourceLink(item.provenance)}
            <a href={sourceLink(item.provenance)}>Read source analysis and evidence</a>
          {:else}
            <p class={memoryCopy}>Provenance is retained with this accepted revision.</p>
          {/if}
        </article>
      {/each}
      <div class={memoryRow}>
        {#if cursor}
          <button class={memoryButton} onclick={()=>{cursor=null;}} type="button">Back to newest knowledge</button>
        {/if}
        {#if query.data.nextCursor}
          <button class={memoryButton} onclick={()=>{cursor=query.data?.nextCursor ?? null;}} type="button">
            More accepted knowledge
          </button>
        {/if}
      </div>
    {/if}
  {/if}
</div>
