<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { MemoryKnowledgeInput } from '@ai-usage/web-contract/memory';
  import { createQuery } from '@tanstack/svelte-query';
  import { immutableRevisionKey } from '../../query/keys';
  import { browserMemoryClient, memoryKnowledgeOptions } from '../../query/options/memory-workspace';
  import { webQueryPolicies } from '../../query/policies';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
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

  const evidenceText = css({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minW: 0 });

  let { projectId = null }: { projectId?: string | null } = $props();
  let kind = $state<MemoryKnowledgeInput['kind']>(null);
  let cursor = $state<string | null>(null);
  let searching = $state(false);
  const rpc = useOptionalWebQueryRpcContext()?.rpc.memory;
  const query = createQuery(() => memoryKnowledgeOptions(rpc, { projectId, kind, cursor, pageSize: 20 }, !searching));
  let selected = $state<{ itemId: string; revisionId: string } | null>(null);
  const detail = createQuery(() => ({
    ...webQueryPolicies.immutableRevision,
    enabled: rpc !== undefined && selected !== null,
    queryKey: immutableRevisionKey('memory', selected?.revisionId ?? '', selected?.itemId ?? '', 'accepted-detail'),
    queryFn: ({ signal }) => {
      if (!selected) {
        throw new Error('Choose an accepted revision.');
      }
      return browserMemoryClient(rpc).getKnowledge(selected, { signal });
    },
  }));
</script>
<div class={memoryStack}>
  <label class={memoryField}
    >Knowledge type<select
      class={memoryInput}
      onchange={() => {
        cursor = null;
      }}
      bind:value={kind}
    >
      <option value={null}>All types</option>
      {#each ['decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference'] as value}
        <option {value}>{value}</option>
      {/each}
    </select></label
  >
  <MemorySearch
    {kind}
    onActiveChange={(active) => {
      searching = active;
    }}
    {projectId}
  />
  {#if !searching}
    {#if query.isPending}
      <p class={memoryCopy} role="status">Reading accepted knowledge…</p>
    {:else if query.error}
      <p class={memoryCopy} role="alert">Accepted knowledge is temporarily unavailable. Check the Memory service.</p>
    {:else if query.data?.items.length === 0}
      <section class={memoryPanel}>
        <h2 class={memoryHeading}>No accepted knowledge in this scope</h2>
        <p class={memoryCopy}>Knowledge appears here after a proposal is explicitly accepted in Pending review.</p>
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
          {#if item.guidance.length > 0}
            <ul>
              {#each item.guidance as guidance}
                <li class={memoryCopy}>{guidance}</li>
              {/each}
            </ul>
          {/if}
          {#if item.contentOmitted}
            <button
              class={memoryButton}
              onclick={() => {
                selected = { itemId: item.id, revisionId: item.revisionId };
              }}
              type="button"
            >
              Read complete accepted revision
            </button>
          {/if}
          {#if selected?.revisionId === item.revisionId}
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
                  <pre class={[memoryCopy, evidenceText]}>{JSON.stringify(detail.data.structuredContent, null, 2)}</pre>
                </details>
              </section>
            {:else if detail.error}
              <p class={memoryCopy} role="alert">This revision could not be read safely.</p>
            {:else}
              <p class={memoryCopy} role="status">Reading the accepted revision…</p>
            {/if}
          {/if}
          <details>
            <summary class={memoryCopy}>Retained provenance</summary>
            {#if item.provenance.sourceLocator}
              <p class={memoryCopy}>{item.provenance.sourceLocator}</p>
            {/if}
            <pre class={[memoryCopy, evidenceText]}>{JSON.stringify(item.provenance, null, 2)}</pre>
          </details>
        </article>
      {/each}
      <div class={memoryRow}>
        {#if cursor}
          <button
            class={memoryButton}
            onclick={() => {
              cursor = null;
            }}
            type="button"
          >
            Back to newest knowledge
          </button>
        {/if}
        {#if query.data.nextCursor}
          <button
            class={memoryButton}
            onclick={() => {
              cursor = query.data?.nextCursor ?? null;
            }}
            type="button"
          >
            More accepted knowledge
          </button>
        {/if}
      </div>
    {/if}
  {/if}
</div>
