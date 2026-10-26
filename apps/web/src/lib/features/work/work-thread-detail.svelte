<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type {
    WorkThreadCommandResult,
    WorkThreadFollowState,
    WorkThreadTaskCommand,
    WorkThreadWait,
  } from '@ai-usage/report-core/work-thread';
  import { taskNativeRequests } from '@ai-usage/report-core/work-thread-situation';
  import type { WorkThreadDetailDataset } from '@ai-usage/report-core/work-thread-view';
  import { createWorkThreadCommandAction, type WorkThreadTaskCommandActionInput } from '../../rpc/work-threads-client';
  import WorkThreadArtifacts from './work-thread-artifacts.svelte';
  import WorkThreadEpisode from './work-thread-episode.svelte';
  import { captureFollowUndo, createFollowUndo, type FollowUndoAction } from './work-thread-follow-undo';
  import WorkThreadMarkers from './work-thread-markers.svelte';
  import {
    acknowledgedRemainderCopy,
    episodeResumeText,
    observedWebUrl,
    primaryResumeEpisode,
    remainderCopy,
    sourceName,
    taskSourceStatuses,
    threadContext,
    threadDate,
    threadDisplayMarkers,
    threadEventActor,
    threadEventCopy,
    threadFactEventCopy,
    threadHistory,
    threadSituationCopy,
    threadTime,
  } from './work-thread-model';
  import WorkThreadSources from './work-thread-sources.svelte';

  export interface SessionChoice {
    readonly caption: string;
    readonly key: string;
    readonly title: string;
  }
  let {
    data,
    timeZone,
    backHref,
    previousHref = null,
    nextHref = null,
    selectedDay = null,
    onBack,
    onCommand,
    onPickerOpen,
    sessionChoices = [],
    sessionsLoading = false,
    sessionsError = null,
    moreSessions = false,
    onMoreSessions,
  }: {
    data: WorkThreadDetailDataset;
    timeZone: string;
    backHref: string;
    previousHref?: string | null;
    nextHref?: string | null;
    selectedDay?: string | null;
    onBack: (event: MouseEvent) => void;
    onCommand: (command: WorkThreadTaskCommand) => Promise<WorkThreadCommandResult>;
    onPickerOpen: () => void;
    sessionChoices?: readonly SessionChoice[];
    sessionsLoading?: boolean;
    sessionsError?: string | null;
    moreSessions?: boolean;
    onMoreSessions: () => void;
  } = $props();
  const row = $derived(data.row);
  const thread = $derived(row.thread);
  const situation = $derived(threadSituationCopy(row, data.generatedAt, data.sources, timeZone));
  const linkedKeys = $derived(
    row.links.filter((link) => link.kind === 'session' && link.detachedAt === null).map((link) => link.key),
  );
  let sessionsOnly = $state(false);
  let showDelegations = $state(false);
  let panel = $state<'end' | 'wait' | 'link' | null>(null);
  let reason = $state('');
  let waitingFor = $state('');
  let waitPrKey = $state('');
  let note = $state<string | null>(null);
  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let toast = $state<string | null>(null);
  let undo = $state<(() => Promise<void>) | null>(null);
  let retry = $state<(() => Promise<void>) | null>(null);
  let newestFirst = $state(true);
  let showLinkChanges = $state(false);
  const history = $derived(
    threadHistory(data, sessionsOnly, timeZone, newestFirst)
      .map((day) => ({
        ...day,
        entries: day.entries.filter(
          (entry) =>
            showLinkChanges || entry.kind !== 'event' || !['link-added', 'link-detached'].includes(entry.event.kind),
        ),
      }))
      .filter((day) => day.entries.length > 0),
  );
  const nativePending = $derived(taskNativeRequests(row));
  const primaryRemainder = $derived(situation.remainders.find((item) => item.kind === situation.reason));
  const primaryPr = $derived(row.markers.pullRequests.find((marker) => marker.key === primaryRemainder?.key));
  const openPr = $derived(
    observedWebUrl(
      (primaryPr?.latest?.outcome === 'observed' ? primaryPr.latest : primaryPr?.latestSuccessful)?.url ?? null,
    ),
  );
  const reviewPrs = $derived(
    row.markers.pullRequests.filter(
      (marker) => (marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful)?.state === 'OPEN',
    ),
  );
  const resumeEpisode = $derived(
    primaryResumeEpisode(
      data.episodes,
      row.runningSessions,
      primaryRemainder?.kind === 'native-request' ? primaryRemainder.request.sessionKey : undefined,
    ),
  );

  type Success = Extract<WorkThreadCommandResult, { ok: true }>;
  const execute = async (command: WorkThreadTaskCommand, success: (result: Success) => void): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    actionError = null;
    retry = null;
    try {
      const result = await onCommand(command);
      if (!result.ok) {
        actionError =
          result.failure === 'revision-conflict' ? 'This task changed in another tab — reloaded' : result.message;
        panel = null;
        undo = null;
        return;
      }
      success(result);
    } catch (caught) {
      actionError = caught instanceof Error ? caught.message : 'The action could not be recorded.';
      // Reuse this command ID after an uncertain response; never double-apply the action.
      retry = () => execute(command, success);
    } finally {
      busy = false;
    }
  };
  const act = (input: WorkThreadTaskCommandActionInput, success: (result: Success) => void): Promise<void> =>
    execute(createWorkThreadCommandAction(input), success);
  const followInput = (
    to: WorkThreadFollowState,
    expectedRevision: number,
    extra?: { waitingFor: string | null; waitingOn: WorkThreadWait | null },
  ): WorkThreadTaskCommandActionInput => ({
    op: 'set-follow-state',
    threadId: thread.threadId,
    expectedRevision,
    to,
    acknowledgedRemainders: to === 'done' ? acknowledgedRemainderCopy(situation.remainders) : [],
    reason: to === 'done' ? reason.trim() || null : null,
    waitingFor: to === 'waiting' ? (extra?.waitingFor ?? waitingFor.trim()) : null,
    waitingOn: to === 'waiting' ? (extra?.waitingOn ?? null) : null,
  });
  const setFollowState = async (to: WorkThreadFollowState): Promise<void> => {
    const previous = captureFollowUndo(data);
    const reviewPr = reviewPrs.find((marker) => marker.key === waitPrKey);
    const wait =
      to === 'waiting' && reviewPr
        ? {
            kind: 'pull-request-review' as const,
            linkKey: reviewPr.key,
            since: new Date().toISOString() as WorkThreadWait['since'],
          }
        : null;
    await act(
      followInput(to, thread.followRevision, { waitingFor: waitingFor.trim() || null, waitingOn: wait }),
      (result) => {
        panel = null;
        reason = '';
        toast = { done: 'Follow-up ended', waiting: 'Marked as waiting', following: 'Follow-up reopened' }[to];
        if (to === 'following' && previous.state === 'waiting') {
          toast = 'Following resumed';
        }
        if (previous.state === 'done' && previous.acknowledgedRemainders === null) {
          toast = 'Follow-up reopened. Undo is unavailable because the original closure is outside the loaded history.';
          undo = null;
          return;
        }
        const restore = createFollowUndo(previous, to, result.followRevision, onCommand);
        undo = () => restoreFollowState(restore);
      },
    );
  };
  // Ending a combination is itself the undo: each task returns with the state it kept (ADR 0080).
  const separate = (): Promise<void> =>
    act({ op: 'separate', expectedRevision: thread.followRevision, threadId: thread.threadId }, () => {
      toast = 'Tasks separated';
      undo = null;
    });
  const restoreFollowState = async (restore: FollowUndoAction): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    actionError = null;
    retry = null;
    try {
      const result = await restore.run();
      toast = null;
      undo = null;
      if (result.status === 'restored') {
        if (thread.followRevision > result.result.followRevision) {
          actionError = 'This task changed in another tab — reloaded';
        } else {
          toast = 'Follow-up restored';
        }
      } else if (result.status === 'history-unavailable') {
        actionError = 'Undo is unavailable because the original closure is outside the loaded history.';
      } else if (result.status === 'refused') {
        const message =
          result.result.failure === 'revision-conflict'
            ? 'This task changed in another tab — reloaded'
            : result.result.message;
        actionError = result.reopened
          ? `Task reopened, but the previous waiting state was not restored. ${message}`
          : message;
      } else {
        actionError = result.reopened
          ? 'Task reopened; restoring the previous waiting state could not be confirmed. Retry to check its outcome.'
          : 'Restoring the follow-up could not be confirmed. Retry to check its outcome.';
        retry = () => restoreFollowState(restore);
      }
    } finally {
      busy = false;
    }
  };
  const end = (): void => {
    if (situation.remainders.length) {
      panel = 'end';
    } else {
      setFollowState('done');
    }
  };
  const copy = async (text: string, message: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast = message;
      undo = null;
    } catch {
      actionError = 'Clipboard unavailable. Select and copy the visible context or command manually.';
    }
  };
  const detach = async (key: string): Promise<void> => {
    const link = row.links.find((candidate) => candidate.key === key && candidate.detachedAt === null);
    if (!link) {
      return;
    }
    await act({ op: 'detach-link', threadId: thread.threadId, linkId: link.linkId }, () => {
      toast = 'Session detached · history stays';
      undo = () =>
        act({ op: 'link', threadId: thread.threadId, kind: link.kind, key: link.key }, () => {
          toast = 'Session linked again';
          undo = null;
        });
    });
  };
  const linkSession = (key: string): Promise<void> =>
    act({ op: 'link', threadId: thread.threadId, kind: 'session', key }, () => {
      panel = null;
      toast = 'Session linked to this task';
      undo = null;
    });
  const primary = (): void => {
    if (situation.action === 'end-follow-up') {
      end();
    } else if (situation.action === 'reopen') {
      setFollowState('following');
    } else if (situation.action === 'resume-session' && resumeEpisode) {
      const text = episodeResumeText(resumeEpisode, thread.title);
      if (text) {
        copy(text, 'Resume command and context copied — nothing was executed');
      }
    } else {
      copy(threadContext(data), 'Task context copied');
    }
  };
  const primaryLabel = $derived.by(() => {
    if (situation.action === 'end-follow-up') {
      return 'End follow-up';
    }
    if (situation.action === 'reopen') {
      return 'Reopen';
    }
    return situation.action === 'resume-session' && resumeEpisode ? 'Resume this session' : 'Copy context';
  });
  const followLabel = $derived({ done: 'Done', waiting: 'Waiting', following: 'Following' }[thread.followState]);
</script>

<nav aria-label="Task navigation" class="wt-crumb">
  <a class="wt-link" href={backHref} onclick={onBack}>← My work</a><span aria-hidden="true">/</span
  ><span>{thread.projectLabel ?? 'No project'}</span>
  <div class="wt-neighbors">
    <span>One task at a time</span>
    {#if previousHref}
      <a aria-label="Previous task" class="wt-button" href={previousHref}>←</a>
    {:else}
      <button aria-label="Previous task" class="wt-button" disabled type="button">←</button>
    {/if}
    {#if nextHref}
      <a aria-label="Next task" class="wt-button" href={nextHref}>→</a>
    {:else}
      <button aria-label="Next task" class="wt-button" disabled type="button">→</button>
    {/if}
  </div>
</nav>
<header class="wt-task-head">
  <div>
    <p class="wt-id">
      Task {thread.threadId.slice(-4)} · Since {threadDate(row.firstActivityAt, timeZone, false, data.generatedAt)}
    </p>
    <h1 data-title-length={thread.title.length > 90 ? 'long' : 'normal'}>
      {thread.title}
    </h1>
    {#if thread.objective}
      <p class="wt-subtitle">{thread.objective}</p>
    {/if}
  </div>
  <div class="wt-follow-controls">
    <span class="wt-follow-state" data-follow-state={thread.followState}>{followLabel}</span>
    {#if thread.followState === 'waiting'}
      <button class="wt-button" disabled={busy} onclick={() => setFollowState('following')} type="button">
        Resume following
      </button>
    {/if}
    <button
      class="wt-button"
      disabled={busy}
      onclick={() => (thread.followState === 'done' ? setFollowState('following') : end())}
      type="button"
    >
      {thread.followState === 'done' ? 'Reopen' : 'End follow-up'}
    </button>
  </div>
</header>
<WorkThreadSources now={data.generatedAt} sources={taskSourceStatuses(data)} {timeZone} />

{#if data.combinedInto}
  <div class="wt-done-banner" role="note">
    <strong>This task was combined into “{data.combinedInto.title}”.</strong>
    <p>
      Its links and history read as part of that task, which also holds its follow-up. Separate them there to follow
      this one on its own again.
    </p>
    <a class="wt-link" href={`/work?task=${data.combinedInto.threadId}`}>Open “{data.combinedInto.title}” →</a>
  </div>
{:else if row.combinedThreads.length > 0}
  <div class="wt-combined-banner">
    <p>
      Combines {row.combinedThreads.length + 1} tasks for one ticket:
      {row.combinedThreads.map((member) => `“${member.title}”`).join(', ')}. Their links and history read here.
    </p>
    <button class="wt-button" disabled={busy} onclick={separate} type="button">Separate</button>
  </div>
{/if}
{#if thread.followState === 'done'}
  <div class="wt-done-banner">
    <strong
      >You ended this follow-up on {threadDate(thread.doneAt ?? thread.updatedAt, timeZone)} · history and links stay
      available.</strong
    >
    <p>No GitHub, Jira or session state was changed by ending it.</p>
    {#if row.afterDone}
      <p>{row.afterDone.count} newer observations since you ended it. Your follow-up stays done.</p>
    {/if}
  </div>
{/if}
<section aria-label="What's left" class="wt-reason">
  <div class="wt-reason-main">
    <div>
      <p class="wt-eyebrow">What's left</p>
      <h2>{situation.headline}</h2>
      <p class="wt-subtitle">{situation.caption}</p>
      {#if nativePending.length}
        <details class="wt-meta">
          <summary>
            {nativePending.length}
            native {nativePending.length === 1 ? 'request' : 'requests'} · {nativePending[0]?.text}
          </summary>
          {#each nativePending as request (request.key)}
            <p>
              {request.text}
              · {request.harness} · {request.sourceSessionId} ·
              {request.askedAt
                ? threadDate(request.askedAt, timeZone, false, data.generatedAt)
                : 'date unknown'}<br>{request.detail}
            </p>
          {/each}
        </details>
      {/if}
    </div>
    <div class="wt-actions">
      {#if situation.action === 'open-pr' && openPr}
        <a class="wt-button wt-primary" href={openPr} rel="noopener noreferrer" target="_blank">Open PR on GitHub ↗</a>
      {:else}
        <button class="wt-button wt-primary" disabled={busy} onclick={primary} type="button">
          {primaryLabel}
        </button>
      {/if}
      {#if thread.followState === 'following'}
        <button
          class="wt-link"
          disabled={busy}
          onclick={() => (panel = panel === 'wait' ? null : 'wait')}
          type="button"
        >
          Mark as waiting
        </button>
      {/if}
    </div>
  </div>
  {#if situation.action === 'resume-session' && resumeEpisode}
    <p class="wt-meta">Copies a verified resume command and context. Nothing is executed here.</p>
  {/if}
  {#if panel === 'end'}
    <div class="wt-inline-panel">
      <h3>These remainders will stay</h3>
      <p>Ending the follow-up changes none of these sources.</p>
      <ul>
        {#each situation.remainders as remainder}
          <li>
            {remainderCopy(remainder)}
            <small
              >{sourceName(remainder.source)}
              · {remainder.key} ·
              {remainder.observedAt
                ? `observed ${threadDate(remainder.observedAt, timeZone)} at ${threadTime(remainder.observedAt, timeZone)}`
                : 'observation date unknown'}</small
            >
          </li>
        {/each}
      </ul>
      <label class="wt-field"
        >Reason (optional)<textarea class="wt-input" maxlength="512" bind:value={reason}></textarea></label
      >
      <div class="wt-actions">
        <button class="wt-button wt-primary" disabled={busy} onclick={() => setFollowState('done')} type="button">
          End anyway
        </button><button class="wt-button" onclick={() => (panel = null)} type="button">Keep following</button>
      </div>
    </div>
  {:else if panel === 'wait'}
    <form
      class="wt-inline-panel"
      onsubmit={(event) => {
        event.preventDefault();
        if (waitingFor.trim()) {
          setFollowState('waiting');
        }
      }}
    >
      <label class="wt-field"
        >Waiting for<input
          class="wt-input"
          maxlength="256"
          placeholder="For example, PR review"
          required
          bind:value={waitingFor}
        ></label
      >
      {#if reviewPrs.length}
        <label class="wt-field"
          >Linked PR review (optional)<select class="wt-input" bind:value={waitPrKey}>
            <option value="">No specific source</option>
            {#each reviewPrs as marker}
              <option value={marker.key}>{marker.key}</option>
            {/each}
          </select></label
        >
      {/if}
      <div class="wt-actions">
        <button class="wt-button wt-primary" disabled={busy || !waitingFor.trim()} type="submit">Wait</button
        ><button class="wt-button" onclick={() => (panel = null)} type="button">Cancel</button>
      </div>
    </form>
  {/if}
</section>
{#if actionError}
  <div class="wt-alert" role="alert">
    {actionError}
    {#if retry}
      <button class="wt-button" disabled={busy} onclick={retry} type="button">Retry action</button>
    {/if}
  </div>
{/if}
<WorkThreadArtifacts now={data.generatedAt} {row} {timeZone} />
<WorkThreadMarkers
  analysisOnly={thread.intent === 'analysis'}
  markers={threadDisplayMarkers(row)}
  now={data.generatedAt}
  {timeZone}
/>

<section aria-labelledby="work-thread-history-title" class="wt-history">
  <div class="wt-history-top">
    <h2 id="work-thread-history-title">The thread of this task</h2>
    <div class="wt-history-controls">
      <fieldset aria-label="History filter" class="wt-mini-tabs">
        <button aria-pressed={sessionsOnly ? 'false' : 'true'} onclick={() => (sessionsOnly = false)} type="button">
          All
        </button><button
          aria-pressed={sessionsOnly ? 'true' : 'false'}
          onclick={() => (sessionsOnly = true)}
          type="button"
        >
          Sessions
        </button>
      </fieldset>
      <label class="wt-switch"><input type="checkbox" bind:checked={showLinkChanges}>Link changes</label>
      <label class="wt-switch"
        >Order
        <select class="wt-input" bind:value={newestFirst}>
          <option value={true}>Newest first</option>
          <option value={false}>Oldest first</option>
        </select>
      </label>
      <label class="wt-switch"
        ><input type="checkbox" bind:checked={showDelegations}>
        Expand all delegations</label
      >
    </div>
  </div>
  <div class="wt-journal">
    {#each history as day (day.key)}
      <section aria-label={day.key} id={`work-day-${day.key}`} class:wt-selected-day={selectedDay === day.key}>
        <h3 class="wt-day-label">
          {threadDate(day.entries[0]?.at ?? `${day.key}T12:00:00Z`, timeZone, true)}
        </h3>
        {#each day.entries as entry (entry.id)}
          <div class="wt-entry">
            <time class="wt-entry-time" datetime={entry.at}>{threadTime(entry.at, timeZone)}</time>
            <div class="wt-entry-body">
              {#if entry.kind === 'session'}
                <WorkThreadEpisode
                  {busy}
                  episode={entry.episode}
                  initiallyOpen={selectedDay === day.key}
                  {linkedKeys}
                  links={row.links}
                  onCopy={copy}
                  onDetach={detach}
                  {showDelegations}
                  taskTitle={thread.title}
                  {timeZone}
                />
              {:else if entry.kind === 'fact-event'}
                {@const factCopy = threadFactEventCopy(entry.event)}
                <div class="wt-event wt-fact-event">
                  <span class="wt-event-source">GitHub</span>
                  <div>
                    <strong>{factCopy.title}</strong>
                    {#if factCopy.detail}
                      <p title={entry.event.key}>{factCopy.detail}</p>
                    {/if}
                  </div>
                </div>
              {:else}
                {@const eventCopy = threadEventCopy(entry.event, data.episodes)}
                <div class="wt-event">
                  <span class="wt-event-source">{threadEventActor(entry.event)}</span>
                  <div>
                    <strong>{eventCopy.title}</strong>
                    {#if eventCopy.detail}
                      <p title={entry.event.linkKey ?? undefined}>{eventCopy.detail}</p>
                    {/if}
                    {#if entry.event.acknowledgedRemainders.length}
                      <details>
                        <summary>Acknowledged remainders</summary>
                        <ul>
                          {#each entry.event.acknowledgedRemainders as remainder}
                            <li>{remainder}</li>
                          {/each}
                        </ul>
                      </details>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </section>
    {:else}
      <p class="wt-empty">
        {sessionsOnly ? 'No linked sessions. A task can exist without a local session.' : 'No history observed yet.'}
      </p>
    {/each}
  </div>
</section>
<div class="wt-minor-ops">
  <span
    >{row.sessionCount}
    linked {row.sessionCount === 1 ? 'session' : 'sessions'}
    {row.delegatedSessionCount > 0 ? ` · ${row.delegatedSessionCount} delegated` : ''}
    · one task</span
  ><button
    class="wt-link"
    onclick={() => {
      panel = panel === 'link' ? null : 'link';
      if (panel === 'link') {
        onPickerOpen();
      }
    }}
    type="button"
  >
    Link an earlier session
  </button>
</div>
{#if panel === 'link'}
  <section aria-label="Link an earlier session" class="wt-inline-panel">
    <h3>Recent sessions · {thread.projectLabel ?? 'No project'}</h3>
    <p>Only served sessions from this project are shown. Linking adds them to this task.</p>
    {#if sessionsError}
      <p role="alert">{sessionsError}</p>
    {:else if sessionsLoading && !sessionChoices.length}
      <p role="status">Reading recent sessions…</p>
    {/if}
    <div class="wt-session-choices">
      {#each sessionChoices.filter((choice) => !linkedKeys.includes(choice.key)) as choice (choice.key)}
        <div class="wt-session-choice">
          <span><strong>{choice.title}</strong><small>{choice.caption}</small></span
          ><button
            aria-label={`Link ${choice.title}`}
            class="wt-button"
            disabled={busy}
            onclick={() => linkSession(choice.key)}
            type="button"
          >
            Link session
          </button>
        </div>
      {:else}
        {#if !(sessionsLoading || sessionsError)}
          <p>No unlinked sessions from this project in the loaded page.</p>
        {/if}
      {/each}
    </div>
    <div class="wt-actions">
      {#if moreSessions}
        <button class="wt-button" disabled={sessionsLoading} onclick={onMoreSessions} type="button">
          Load more sessions
        </button>
      {/if}
      <button class="wt-button" onclick={() => (panel = null)} type="button">Cancel</button>
    </div>
  </section>
{/if}
{#if data.detachedLinks.some((link) => link.kind === 'session')}
  <details class="wt-detached">
    <summary>{data.detachedLinks.filter((link) => link.kind === 'session').length} detached sessions</summary>
    {#each data.detachedLinks.filter((link) => link.kind === 'session') as link}
      <div class="wt-session-choice">
        <span>{link.key}</span
        ><button class="wt-link" disabled={busy} onclick={() => linkSession(link.key)} type="button">Link again</button>
      </div>
    {/each}
  </details>
{/if}
<details class="wt-note">
  <summary>Resume note, if needed</summary>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      act({ op: 'set-note', threadId: thread.threadId, note: (note ?? thread.note ?? '').trim() || null }, () => {
        toast = 'Resume note saved';
        undo = null;
      });
    }}
  >
    <label class="wt-field"
      >Resume note<textarea
        class="wt-input"
        maxlength="2000"
        oninput={(event) => (note = event.currentTarget.value)}
        value={note ?? thread.note ?? ''}
      ></textarea></label
    ><button class="wt-button" disabled={busy} type="submit">Save note</button>
  </form>
</details>
{#if toast}
  <div class="wt-toast" role="status">
    <span>{toast}</span>
    {#if undo}
      <button disabled={busy} onclick={undo} type="button">Undo</button>
    {/if}
    <button
      aria-label="Dismiss notification"
      onclick={() => {
        toast = null;
        undo = null;
      }}
      type="button"
    >
      ×
    </button>
  </div>
{/if}
