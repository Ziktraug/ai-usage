<script lang="ts">
  import type {
    WorkIntakeCommandResult,
    WorkThreadCommand,
    WorkThreadCommandResult,
  } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadJiraIntakeItem, WorkThreadRow } from '@ai-usage/report-core/work-thread-view';
  import { createWorkThreadCommandAction, type WorkThreadCommandActionInput } from '../../rpc/work-threads-client';
  import { observedWebUrl, threadDate } from './work-thread-model';

  let {
    items,
    truncated,
    tasks,
    now,
    timeZone,
    onCommand,
  }: {
    items: readonly WorkThreadJiraIntakeItem[];
    truncated: boolean;
    /** Open tasks loaded in the list, offered as attachment targets. */
    tasks: readonly WorkThreadRow[];
    now: string;
    timeZone: string;
    onCommand: (command: WorkThreadCommand) => Promise<WorkThreadCommandResult | WorkIntakeCommandResult>;
  } = $props();
  // Held here: a refetch can briefly empty the block, and a remounted <details> would fold again.
  let open = $state(false);

  let busyKey = $state<string | null>(null);
  let failure = $state<{ key: string; message: string } | null>(null);
  let lastDismissed = $state<{ key: string; label: string } | null>(null);

  const issueKey = (key: string): string => key.slice(key.lastIndexOf('/') + 1);
  const run = async (key: string, input: WorkThreadCommandActionInput, after?: () => void): Promise<void> => {
    if (busyKey) {
      return;
    }
    busyKey = key;
    failure = null;
    try {
      const result = await onCommand(createWorkThreadCommandAction(input));
      if (result.ok) {
        after?.();
      } else {
        failure = { key, message: result.message };
      }
    } catch (error) {
      failure = { key, message: error instanceof Error ? error.message : 'The choice could not be recorded.' };
    } finally {
      busyKey = null;
    }
  };
  const follow = (item: WorkThreadJiraIntakeItem) =>
    run(item.key, {
      op: 'create',
      title: item.issue?.summary ?? issueKey(item.key),
      intent: 'change',
      objective: null,
      // The Jira project is not where the work lands; the task takes its PR's repository.
      projectLabel: null,
      links: [{ kind: 'jira-issue', key: item.key }],
    });
  const attach = (item: WorkThreadJiraIntakeItem, threadId: string) =>
    run(item.key, { op: 'link', threadId, kind: 'jira-issue', key: item.key });
  const dismiss = (item: WorkThreadJiraIntakeItem) =>
    run(item.key, { op: 'dismiss-intake', key: item.key, dismissed: true }, () => {
      lastDismissed = { key: item.key, label: issueKey(item.key) };
    });
  const restore = (key: string) =>
    run(key, { op: 'dismiss-intake', key, dismissed: false }, () => {
      lastDismissed = null;
    });
</script>

{#if items.length > 0 || lastDismissed}
  <details class="wt-intake wt-jira-intake" bind:open>
    <summary>
      <span aria-hidden="true" class="wt-intake-chevron">›</span>
      <strong>Assigned in Jira</strong>
      <span class="wt-intake-count"
        >{items.length}{truncated ? '+' : ''}
        {items.length === 1 ? 'ticket' : 'tickets'}
        not followed yet</span
      >
      <span class="wt-intake-hint">Follow one to make it a task; assignment alone is not a commitment.</span>
    </summary>
    <ul>
      {#each items as item (item.key)}
        {@const url = observedWebUrl(item.issue?.url ?? null)}
        {@const label = issueKey(item.key)}
        <li class="wt-intake-item">
          <div class="wt-intake-issue">
            {#if url}
              <a class="wt-link" href={url} rel="noopener noreferrer" target="_blank">{label} ↗</a>
            {:else}
              <span>{label}</span>
            {/if}
            <span class="wt-pill" data-tone={`jira-${item.issue?.statusCategory ?? 'unknown'}`}
              >{item.issue?.status ?? 'Not read yet'}</span
            >
            <strong>{item.issue?.summary ?? 'Summary not read yet'}</strong>
            <small>Assigned since {threadDate(item.firstSeenAt, timeZone, false, now)}</small>
          </div>
          <div class="wt-intake-actions">
            <button class="wt-button" disabled={busyKey !== null} onclick={() => follow(item)} type="button">
              Follow
            </button>
            {#if tasks.length > 0}
              <label class="wt-sr" for={`wt-attach-${label}`}>Attach {label} to a task</label>
              <select
                class="wt-input"
                disabled={busyKey !== null}
                id={`wt-attach-${label}`}
                onchange={(event) => {
                  const threadId = event.currentTarget.value;
                  event.currentTarget.value = '';
                  if (threadId) {
                    attach(item, threadId);
                  }
                }}
              >
                <option value="">Attach to a task…</option>
                {#each tasks as task (task.thread.threadId)}
                  <option value={task.thread.threadId}>{task.thread.title}</option>
                {/each}
              </select>
            {/if}
            <button class="wt-button" disabled={busyKey !== null} onclick={() => dismiss(item)} type="button">
              Dismiss
            </button>
          </div>
          {#if failure?.key === item.key}
            <p class="wt-read-warning" role="alert">{failure.message}</p>
          {/if}
        </li>
      {/each}
    </ul>
    {#if lastDismissed}
      {@const dismissed = lastDismissed}
      <p class="wt-intake-undo" role="status">
        {dismissed.label}
        dismissed; it stays hidden while assigned.
        <button class="wt-button" disabled={busyKey !== null} onclick={() => restore(dismissed.key)} type="button">
          Undo
        </button>
      </p>
    {/if}
  </details>
{/if}
