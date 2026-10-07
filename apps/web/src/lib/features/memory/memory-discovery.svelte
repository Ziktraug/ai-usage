<script lang="ts">
  import type { MemoryContractClient } from '@ai-usage/web-contract/memory';
  import type {
    DistillationProjectsPage,
    SessionDistillationDiscoverRequest,
  } from '@ai-usage/web-contract/session-distillation';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { memoryWorkspaceDiscoveryOptions } from '../../query/options/memory-workspace';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { memoryAnalysisError } from './memory-errors';
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
  import { memoryDateBound } from './memory-url';

  let { projects, projectId = null }: { projects: DistillationProjectsPage['items']; projectId?: string | null } =
    $props();
  let chosenProject = $state(untrack(() => projectId ?? ''));
  let since = $state('');
  let until = $state('');
  let limit = $state(5);
  let request = $state<SessionDistillationDiscoverRequest>();
  let selectedRows = $state<string[]>([]);
  let copied = $state(false);
  let message = $state('');
  const rpc = useOptionalWebQueryRpcContext()?.rpc.sessionDistillation;
  const query = createQuery(() => memoryWorkspaceDiscoveryOptions(rpc, request));
  const preview = $derived(query.data);
  $effect(() => {
    selectedRows = preview?.selections.map((selection) => selection.rowId) ?? [];
    copied = false;
  });
  const command = $derived(
    preview
      ? `${preview.prepareCommand}${selectedRows.map((row) => ` --row '${row.replaceAll("'", "'\\''")}'`).join('')}`
      : '',
  );
  const instruction = $derived(
    `Use the session-distillation skill with this exact selection. First confirm authorization to read these local sessions and to process their redacted content with the active harness subscription. Then run:\n\n${command}\n\nContinue existing jobs when present, consolidate all snapshot segments, and read the saved analyses. Do not use another provider or read unrelated histories.`,
  );
  const discover = (event: SubmitEvent) => {
    event.preventDefault();
    message = '';
    if (!chosenProject) {
      return;
    }
    if (since && until && since >= until) {
      message = 'The end date must be after the start date.';
      return;
    }
    request = {
      kind: 'discover',
      selector: { kind: 'project', value: chosenProject },
      since: memoryDateBound(since),
      until: memoryDateBound(until),
      limit,
    };
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(instruction);
      copied = true;
    } catch {
      message = 'Clipboard access is unavailable. Select and copy the instruction below.';
    }
  };
  const toggle = (row: string, checked: boolean) => {
    selectedRows = checked ? [...selectedRows, row] : selectedRows.filter((value) => value !== row);
    copied = false;
  };
</script>
<section aria-labelledby="memory-discovery-heading" class={memoryPanel}>
  <h2 class={memoryHeading} id="memory-discovery-heading">Analyse selected sessions</h2>
  <p class={memoryCopy}>
    Choose a recognized Project and preview its local Codex sessions. Discovery reads metadata only. The active harness
    performs generation after your separate authorization for local reading and provider processing.
  </p>
  {#if projects.length===0}
    <p class={memoryCopy}>
      No acknowledged local Project mapping is available.
      <a href="/projects">Resolve the Project and Checkout</a>
      before discovering sessions.
    </p>
  {/if}
  <form class={memoryRow} onsubmit={discover}>
    <label class={memoryField}
      >Project to analyse<select class={memoryInput} required bind:value={chosenProject}>
        <option value="">Choose a Project</option>
        {#each projects as project (project.projectId)}
          <option value={project.projectId}>{project.displayName}</option>
        {/each}
      </select></label
    >
    <label class={memoryField}>From (UTC, inclusive)<input class={memoryInput} type="date" bind:value={since}></label>
    <label class={memoryField}>Before (UTC, exclusive)<input class={memoryInput} type="date" bind:value={until}></label>
    <label class={memoryField}
      >Maximum sessions<input class={memoryInput} max="10" min="1" type="number" bind:value={limit}></label
    >
    <button class={memoryButton} disabled={!chosenProject || query.isFetching} type="submit">Preview sessions</button>
  </form>
  {#if query.isFetching}
    <p class={memoryCopy} role="status">Discovering eligible session metadata…</p>
  {/if}
  {#if query.error}
    <p class={memoryCopy} role="alert">
      {memoryAnalysisError(query.error,'Sessions could not be discovered. Check the Project mapping, then refresh this preview explicitly.')}
    </p>
  {/if}
  {#if preview}
    <p class={memoryCopy}>
      Selection for {preview.projectName} · previewed {new Date(preview.createdAt).toLocaleString()}. Preparing this
      selection verifies the same report and mappings; a stale selection must be previewed again.
    </p>
    {#if preview.candidates.length===0}
      <p class={memoryCopy}>No eligible local Codex sessions in this period.</p>
    {/if}
    <div class={memoryStack}>
      {#each preview.candidates as candidate (candidate.selection.rowId)}
        <label class={memoryCopy}>
          <input
            checked={selectedRows.includes(candidate.selection.rowId)}
            disabled={!candidate.eligible}
            onchange={(event)=>toggle(candidate.selection.rowId,event.currentTarget.checked)}
            type="checkbox"
          >
          {candidate.label}
          · {candidate.sessionDate ? new Date(candidate.sessionDate).toLocaleDateString() : 'Session date unknown'} ·
          {candidate.status.state}
          {#if !candidate.eligible}
            · {candidate.reason}
          {/if}
        </label>
      {/each}
    </div>
    {#if selectedRows.length>0}
      <button class={memoryButton} onclick={copy} type="button">
        {copied ? 'Instruction copied' : `Copy skill instruction for ${selectedRows.length} session${selectedRows.length===1 ? '' : 's'}`}
      </button>
      <p class={memoryCopy}>
        Copying an instruction does not start generation. Give it to your active coding agent; the browser does not run
        an inference worker.
      </p>
      <details>
        <summary class={memoryCopy}>Exact instruction and command</summary>
        <textarea
          aria-label="Distillation skill instruction"
          class={memoryInput}
          readonly
          rows="8"
          value={instruction}
        ></textarea>
      </details>
    {/if}
  {/if}
  {#if message}
    <p class={memoryCopy} role="status">{message}</p>
  {/if}
</section>
