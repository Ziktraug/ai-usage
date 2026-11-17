<script lang="ts">
  import type { WorkThreadRow, WorkThreadSourceStatus } from '@ai-usage/report-core/work-thread-view';
  import { tick } from 'svelte';
  import { formatExactInstant, formatRelativeAge } from './work-attention-model';
  import { type DiskCheckout, describeDiskPullRequest, describeDiskSource, diskLensOf } from './work-disk-model';
  import { observedWebUrl, threadDate } from './work-thread-model';
  import './work-disk.css';

  let {
    rows,
    now,
    timeZone,
    href,
    coverage,
    sources,
  }: {
    rows: readonly WorkThreadRow[];
    now: string;
    timeZone: string;
    href: (threadId: string) => string;
    coverage: { loaded: number; total: number; complete: boolean };
    /** How the sources answered over every page read; the note shows those with something to say. */
    sources: readonly WorkThreadSourceStatus[];
  } = $props();

  /**
   * The task cell holds two lines at most, so a row stays compact: up to two tasks are named, and
   * beyond that the first one with the others unfolding on demand.
   */
  const TASK_LINES = 2;
  const namedTasks = (tasks: DiskCheckout['tasks']): number => (tasks.length > TASK_LINES ? 1 : tasks.length);

  const lens = $derived(diskLensOf(rows, now, coverage.complete));
  const allCommands = $derived(
    lens.groups.flatMap((group) =>
      group.repositories.flatMap((repository) => repository.items.flatMap((item) => item.commands)),
    ),
  );
  const count = (value: number, noun: string, plural = `${noun}s`): string => `${value} ${value === 1 ? noun : plural}`;
  // Sentences are assembled here, not in the markup, so formatting never moves their punctuation.
  const scope = $derived(
    [
      `Lists the checkouts that followed and done tasks name. ${coverage.loaded} of ${coverage.total} tasks read.`,
      ...(coverage.complete ? [] : ['The list is partial: the remaining tasks were not read.']),
      ...(lens.branchesWithoutCheckout > 0
        ? [
            `${count(lens.branchesWithoutCheckout, 'linked branch has', 'linked branches have')} no known checkout on this machine.`,
          ]
        : []),
      'Worktrees no task names are not listed.',
    ].join(' '),
  );
  const sourceNotes = $derived(
    sources.flatMap((status) => {
      const words = describeDiskSource(status);
      return words === null ? [] : [{ lastRunAt: status.lastRunAt, source: status.source, words }];
    }),
  );

  let copyStatus = $state<{ failed: boolean; message: string } | null>(null);
  /**
   * The status is emptied first and set once that reached the page: assistive technology announces
   * a live region when its text changes, so copying the same thing twice would otherwise stay silent.
   */
  const copy = async (commands: readonly string[], copied: string): Promise<void> => {
    copyStatus = null;
    let failed = false;
    try {
      await navigator.clipboard.writeText(commands.join('\n'));
    } catch {
      failed = true;
    }
    await tick();
    copyStatus = failed
      ? { failed, message: 'Copy failed: select the text instead' }
      : { failed, message: `Copied ${copied}` };
  };
</script>

{#snippet when(
  at: string,
)}
  <time datetime={at} title={formatExactInstant(at)}>{formatRelativeAge(at, now)}</time>
  <span class="wt-meta">{threadDate(at, timeZone, false, now)}</span>
{/snippet}

{#snippet taskLink(
  task: DiskCheckout['tasks'][number],
)}
  <span class="wd-task">
    <a class="wt-link" href={href(task.threadId)} title={task.title}>{task.title}</a>
    {#if task.done}
      <span class="wt-meta">· done</span>
    {/if}
  </span>
{/snippet}

<div class="wd-summary">
  <p>
    <strong>{count(lens.checkoutCount, 'checkout')}</strong>
    · {count(lens.repositoryCount, 'repository', 'repositories')}
  </p>
  <nav aria-label="Checkout groups">
    <ul class="wd-jump">
      {#each lens.groups as group (group.group)}
        <li>
          <a class="wt-link" href={`#wd-group-${group.group}`}>{group.label} <b>{group.count}</b></a>
        </li>
      {/each}
    </ul>
  </nav>
</div>
<p class="wd-scope">
  {scope}
  {#each sourceNotes as note (note.source)}
    {' '}{note.words}
    {#if note.lastRunAt}
      Last run
      <time datetime={note.lastRunAt} title={formatExactInstant(note.lastRunAt)}
        >{formatRelativeAge(note.lastRunAt, now)}</time
      >.
    {:else}
      No run recorded.
    {/if}
  {/each}
</p>

{#each lens.groups as group (group.group)}
  {@const safe = group.group === 'safe-to-remove'}
  {@const removable = safe && !lens.commandsWithheld}
  <section aria-labelledby={`wd-group-${group.group}`} class="wd-group">
    <h2 id={`wd-group-${group.group}`}>{group.label} <span>· {group.count}</span></h2>
    <p class="wd-note">{group.note}</p>
    {#if group.count === 0}
      <p class="wd-none">{group.empty}</p>
    {:else}
      {#if removable}
        <div class="wd-actions">
          <button
            class="wt-button"
            onclick={() => copy(allCommands, count(allCommands.length, 'command'))}
            type="button"
          >
            Copy all commands
          </button>
          <p>
            Nothing here runs git. <code>git worktree remove</code> refuses a worktree with modified or untracked files,
            but deletes ignored files (.env, local stores) with it. <code>git branch -d</code> refuses an unmerged
            branch.
          </p>
        </div>
        <p aria-live="polite" class="wd-copy-status" data-tone={copyStatus?.failed ? 'error' : 'ok'} role="status">
          {copyStatus?.message ?? ''}
        </p>
      {:else if safe}
        <p class="wd-withheld">Commands are withheld until every task is read.</p>
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a horizontally scrollable region must be keyboard-reachable -->
      <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
      <section aria-label={`${group.label} checkouts`} class="wd-scroll" tabindex="0">
        <table class="wd-table" data-commands={removable ? '' : undefined}>
          <caption class="wd-sr-only">
            {group.label}
          </caption>
          <colgroup>
            <col class="wd-col-checkout">
            <col class="wd-col-branch">
            <col class="wd-col-task">
            <col class="wd-col-pr">
            <col class="wd-col-state">
            <col class="wd-col-session">
            <col class="wd-col-observed">
            {#if removable}
              <col class="wd-col-command">
            {/if}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Checkout</th>
              <th scope="col">Branch</th>
              <th scope="col">Task</th>
              <th scope="col">Pull request</th>
              <th scope="col">Disk state</th>
              <th scope="col">Last session</th>
              <th scope="col">Observed</th>
              {#if removable}
                <th scope="col">Command</th>
              {/if}
            </tr>
          </thead>
          {#each group.repositories as repository (repository.project)}
            <tbody>
              <tr class="wd-repository">
                <th colspan={removable ? 8 : 7} scope="rowgroup" title={repository.project}>
                  {repository.label} <span>· {count(repository.items.length, 'checkout')}</span>
                </th>
              </tr>
              {#each repository.items as item (item.checkout.id)}
                {@const checkout = item.checkout}
                {@const named = namedTasks(checkout.tasks)}
                <tr data-disk-checkout={checkout.path} data-disk-group={group.group}>
                  <th scope="row">
                    <code class="wd-path" title={checkout.path}>{item.shortPath}</code>
                    {#if item.shortPath !== checkout.path}
                      <span class="wd-sr-only">Full path {checkout.path}</span>
                    {/if}
                  </th>
                  <td class="wd-branch-cell">
                    {#if checkout.branch !== null}
                      <code class="wd-branch">{checkout.branch}</code>
                      {#if checkout.branchSource === 'last-seen'}
                        <span class="wt-meta">(last seen)</span>
                      {:else if checkout.branchSource === 'link'}
                        <span class="wt-meta">(from the task link)</span>
                      {/if}
                    {:else if checkout.state.kind === 'present'}
                      Detached
                    {:else}
                      Unknown
                    {/if}
                    {#if checkout.role === 'primary'}
                      <span class="wd-tag">main checkout</span>
                    {:else if checkout.role === 'worktree'}
                      <span class="wd-tag">worktree</span>
                    {/if}
                  </td>
                  <td>
                    <div class="wd-tasks">
                      {#each checkout.tasks.slice(0, named) as task (task.threadId)}
                        {@render taskLink(task)}
                      {/each}
                      {#if checkout.tasks.length > named}
                        <details>
                          <summary>+{checkout.tasks.length - named} more</summary>
                          {#each checkout.tasks.slice(named) as task (task.threadId)}
                            {@render taskLink(task)}
                          {/each}
                        </details>
                      {/if}
                    </div>
                  </td>
                  <td>
                    {#if checkout.pullRequest}
                      {@const pullRequest = checkout.pullRequest}
                      {@const url = observedWebUrl(pullRequest.url)}
                      <span class="wd-pr">
                        {#if url}
                          <a class="wt-link" href={url} rel="noreferrer" target="_blank" title={pullRequest.title}
                            >PR #{pullRequest.number} <span class="wd-sr-only">on GitHub, opens in a new tab</span></a
                          >
                        {:else}
                          <span>PR #{pullRequest.number}</span>
                        {/if}
                        <span>{describeDiskPullRequest(pullRequest)}</span>
                      </span>
                    {:else}
                      <span aria-hidden="true">—</span><span class="wd-sr-only">No pull request for this branch</span>
                    {/if}
                  </td>
                  <td>
                    <span class="wd-state" data-state={item.disk.tone}>
                      <span aria-hidden="true" class="wd-glyph">{item.disk.glyph}</span>
                      {item.disk.words}
                    </span>
                    {#if item.detail !== null}
                      <span class="wt-meta">{item.detail}</span>
                    {/if}
                  </td>
                  <td class="wd-when">
                    {#if checkout.lastSessionAt}
                      {@render when(checkout.lastSessionAt)}
                    {:else}
                      <span class="wt-meta">No linked session here</span>
                    {/if}
                  </td>
                  <td class="wd-when">
                    {#if checkout.state.kind === 'absent' && checkout.observedAt && checkout.lastPresentAt}
                      <!-- The second line names when the path was last there; the read's own date is in its title. -->
                      <time datetime={checkout.observedAt} title={formatExactInstant(checkout.observedAt)}
                        >{formatRelativeAge(checkout.observedAt, now)}</time
                      >
                      <span class="wt-meta">
                        <span class="wd-sr-only">last</span>
                        present
                        <time datetime={checkout.lastPresentAt} title={formatExactInstant(checkout.lastPresentAt)}
                          >{threadDate(checkout.lastPresentAt, timeZone, false, now)}</time
                        >
                      </span>
                    {:else if checkout.observedAt}
                      {@render when(checkout.observedAt)}
                    {:else}
                      Never
                    {/if}
                  </td>
                  {#if removable}
                    <td>
                      <div class="wd-command">
                        <code class="wt-code">{item.commands.join('\n')}</code>
                        <button
                          aria-label={`Copy the command for ${item.shortPath}`}
                          class="wt-button"
                          onclick={() => copy(item.commands, `the command for ${item.shortPath}`)}
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          {/each}
        </table>
      </section>
    {/if}
  </section>
{/each}
