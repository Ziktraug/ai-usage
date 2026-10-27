<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { sessionLinkKey, type WorkThreadCommand, type WorkThreadIntent } from '@ai-usage/report-core/work-thread';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { invalidateWorkThreadQueries } from '../../query/options/work-threads';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createWorkThreadCommandAction, createWorkThreadsClient } from '../../rpc/work-threads-client';
  import { workButton, workInput, workLink, workMuted, workRow, workStack } from './work-styles';

  let { row }: { row: SessionPresentationRow } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const queryClient = useQueryClient();
  let expanded = $state(false);
  let title = $state(untrack(() => row.sessionLabel || row.name || 'Untitled task'));
  let intent = $state<WorkThreadIntent>('change');
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let createdId = $state<string | null>(null);
  let retryCommand = $state<WorkThreadCommand | null>(null);
  const create = async (): Promise<void> => {
    if (!rpc || pending || !row.source?.machineId || !row.source.sourceSessionId) {
      return;
    }
    const command =
      retryCommand ??
      createWorkThreadCommandAction({
        op: 'create',
        title: title.trim(),
        intent,
        objective: null,
        projectLabel: row.projectLabel || null,
        links: [
          {
            kind: 'session',
            key: sessionLinkKey({
              harness: row.source.harnessKey,
              machineId: row.source.machineId,
              sessionId: row.source.sourceSessionId,
            }),
          },
        ],
      });
    pending = true;
    failure = null;
    try {
      const result = await createWorkThreadsClient(rpc.workThreads).command(command);
      if (!result.ok) {
        failure = result.message;
        retryCommand = null;
      } else if (result.threadId !== null) {
        createdId = result.threadId;
        retryCommand = null;
        await invalidateWorkThreadQueries(queryClient, result.threadId);
      }
    } catch (error) {
      retryCommand = command;
      failure = error instanceof Error ? error.message : 'Task creation failed.';
    } finally {
      pending = false;
    }
  };
</script>

{#if row.source?.machineId && row.source.sourceSessionId}
  {#if createdId}
    <p class={workMuted} role="status">
      Task created. <a class={workLink} href={`/work?task=${encodeURIComponent(createdId)}`}>Open task</a>
    </p>
  {:else}
    <div class={workStack}>
      <button
        aria-expanded={expanded ? 'true' : 'false'}
        class={workButton}
        onclick={() => (expanded = !expanded)}
        type="button"
      >
        Follow as a task
      </button>
      {#if expanded}
        <form
          class={workStack}
          onsubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <label class={workMuted}
            >Task title<input
              class={workInput}
              disabled={pending || retryCommand !== null}
              maxlength="200"
              required
              bind:value={title}
            ></label
          ><label class={workMuted}
            >Intent<select class={workInput} disabled={pending || retryCommand !== null} bind:value={intent}>
              <option value="change">Change</option>
              <option value="analysis">Analysis</option>
              <option value="review">Review</option>
            </select></label
          >
          <p class={workMuted}>The session becomes a linked episode. Its own state is unchanged.</p>
          {#if failure}
            <p class={workMuted} role="alert">{failure}</p>
          {/if}
          <div class={workRow}>
            <button class={workButton} disabled={pending || !title.trim()} type="submit">
              {retryCommand ? 'Retry creation' : 'Create task'}
            </button><button class={workButton} onclick={() => (expanded = false)} type="button">Cancel</button>
          </div>
        </form>
      {/if}
    </div>
  {/if}
{/if}
