<script lang="ts">
  import type {
    WorkIntakeCommandResult,
    WorkThreadCommand,
    WorkThreadCommandResult,
  } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadCombineSuggestion } from '@ai-usage/report-core/work-thread-view';
  import { createWorkThreadCommandAction, type WorkThreadCommandActionInput } from '../../rpc/work-threads-client';
  import { observedWebUrl } from './work-thread-model';

  let {
    items,
    truncated,
    onCommand,
  }: {
    items: readonly WorkThreadCombineSuggestion[];
    truncated: boolean;
    onCommand: (command: WorkThreadCommand) => Promise<WorkThreadCommandResult | WorkIntakeCommandResult>;
  } = $props();
  // Held here: a refetch can briefly empty the block, and a remounted <details> would fold again.
  let open = $state(false);

  let busy = $state(false);
  let failures = $state<Record<string, string>>({});
  /** Combinations applied from this block, kept for an immediate Undo. */
  let applied = $state<{ ticket: string; threadId: string; revision: number; title: string }[]>([]);

  const ticketLabel = (key: string): string => key.slice(key.lastIndexOf('/') + 1);
  const prLabel = (key: string): string => `#${key.slice(key.lastIndexOf('#') + 1)}`;
  const ready = $derived(items.filter((item) => item.blockers.length === 0));
  const countLabel = $derived(
    items.length === 0
      ? 'All combined; undo below if needed'
      : `${items.length}${truncated ? '+' : ''} ${items.length === 1 ? 'ticket' : 'tickets'} to combine`,
  );

  const send = async (input: WorkThreadCommandActionInput) => {
    try {
      return await onCommand(createWorkThreadCommandAction(input));
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'The choice could not be recorded.',
      };
    }
  };
  const combine = async (item: WorkThreadCombineSuggestion): Promise<void> => {
    const result = await send({
      op: 'combine',
      participants: item.participants.map((participant) => ({
        expectedRevision: participant.followRevision,
        threadId: participant.threadId,
      })),
      threadId: item.keptThreadId,
      ticketKey: item.ticketKey,
    });
    if (result.ok) {
      const kept = item.participants.find((participant) => participant.threadId === item.keptThreadId);
      applied = [
        ...applied,
        {
          revision: result.followRevision,
          threadId: item.keptThreadId,
          ticket: ticketLabel(item.ticketKey),
          title: kept?.title ?? ticketLabel(item.ticketKey),
        },
      ];
    } else {
      failures = { ...failures, [item.ticketKey]: result.message };
    }
  };
  const run = async (targets: readonly WorkThreadCombineSuggestion[]): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    failures = {};
    // One command per ticket: each combination succeeds or is refused on its own.
    for (const item of targets) {
      await combine(item);
    }
    busy = false;
  };
  const separate = async (entry: (typeof applied)[number]): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    const result = await send({ op: 'separate', expectedRevision: entry.revision, threadId: entry.threadId });
    if (result.ok) {
      applied = applied.filter((item) => item !== entry);
    } else {
      failures = { ...failures, [entry.threadId]: result.message };
    }
    busy = false;
  };
</script>

{#if items.length > 0 || applied.length > 0}
  <details class="wt-intake wt-combine" bind:open>
    <summary>
      <span aria-hidden="true" class="wt-intake-chevron">›</span>
      <strong>Same ticket, several tasks</strong>
      <span class="wt-intake-count">{countLabel}</span>
      <span class="wt-intake-hint"
        >Combining keeps every link and history; the ticket's task stays and the others read as part of it. You can
        separate them again.</span
      >
    </summary>
    {#if ready.length > 1}
      <div class="wt-combine-all">
        <button class="wt-button" disabled={busy} onclick={() => run(ready)} type="button">
          Combine all {ready.length}
        </button>
      </div>
    {/if}
    <ul>
      {#each items as item (item.ticketKey)}
        {@const url = observedWebUrl(item.issue?.url ?? null)}
        {@const kept = item.participants.find((participant) => participant.threadId === item.keptThreadId)}
        <li class="wt-intake-item">
          <div class="wt-intake-issue">
            {#if url}
              <a class="wt-link" href={url} rel="noopener noreferrer" target="_blank"
                >{ticketLabel(item.ticketKey)}
                ↗</a
              >
            {:else}
              <span>{ticketLabel(item.ticketKey)}</span>
            {/if}
            {#if item.issue?.status}
              <span class="wt-pill" data-tone={`jira-${item.issue.statusCategory ?? 'unknown'}`}
                >{item.issue.status}</span
              >
            {/if}
            <strong>Keeps “{kept?.title ?? 'the ticket task'}”</strong>
            <ul class="wt-combine-participants">
              {#each item.participants as participant (participant.threadId)}
                <li>
                  {participant.threadId === item.keptThreadId ? 'Kept' : 'Joins'}
                  · {participant.title}
                  {#if participant.pullRequestKeys.length > 0}
                    · {participant.pullRequestKeys.map(prLabel).join(', ')}
                  {/if}
                  {#if participant.sessionCount > 0}
                    · {participant.sessionCount}
                    {participant.sessionCount === 1 ? 'session' : 'sessions'}
                  {/if}
                </li>
              {/each}
            </ul>
            {#each item.blockers as blocker}
              <small class="wt-read-warning">{blocker}</small>
            {/each}
          </div>
          <div class="wt-intake-actions">
            <button
              class="wt-button"
              disabled={busy || item.blockers.length > 0}
              onclick={() => run([item])}
              type="button"
            >
              Combine {item.participants.length} tasks
            </button>
          </div>
          {#if failures[item.ticketKey]}
            <p class="wt-read-warning" role="alert">{failures[item.ticketKey]}</p>
          {/if}
        </li>
      {/each}
    </ul>
    {#each applied as entry (entry.threadId)}
      <p class="wt-intake-undo" role="status">
        {entry.ticket}
        combined into “{entry.title}”.
        <button class="wt-button" disabled={busy} onclick={() => separate(entry)} type="button">Undo</button>
        {#if failures[entry.threadId]}
          <span class="wt-read-warning">{failures[entry.threadId]}</span>
        {/if}
      </p>
    {/each}
  </details>
{/if}
