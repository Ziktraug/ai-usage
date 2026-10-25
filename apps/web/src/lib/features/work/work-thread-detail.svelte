<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type {
    WorkThreadCommand,
    WorkThreadCommandResult,
    WorkThreadFollowState,
    WorkThreadWait,
  } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadDetailDataset } from '@ai-usage/report-core/work-thread-view';
  import { createWorkThreadCommandAction, type WorkThreadCommandActionInput } from '../../rpc/work-threads-client';
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
  import { threadStyles } from './work-thread-styles';

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
    onCommand: (command: WorkThreadCommand) => Promise<WorkThreadCommandResult>;
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
  const history = $derived(threadHistory(data, sessionsOnly, timeZone));
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
  const resumeEpisode = $derived(primaryResumeEpisode(data.episodes, row.runningSessions));

  type Success = Extract<WorkThreadCommandResult, { ok: true }>;
  const execute = async (command: WorkThreadCommand, success: (result: Success) => void): Promise<void> => {
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
  const act = (input: WorkThreadCommandActionInput, success: (result: Success) => void): Promise<void> =>
    execute(createWorkThreadCommandAction(input), success);
  const followInput = (
    to: WorkThreadFollowState,
    expectedRevision: number,
    extra?: { waitingFor: string | null; waitingOn: WorkThreadWait | null },
  ): WorkThreadCommandActionInput => ({
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

<nav aria-label="Task navigation" class={`wt-crumb ${threadStyles.crumb}`}>
  <a class={`wt-link ${threadStyles.link}`} href={backHref} onclick={onBack}>← My work</a
  ><span aria-hidden="true">/</span><span>{thread.projectLabel ?? 'No project'}</span>
  <div class={`wt-neighbors ${threadStyles.neighbors}`}>
    <span>One task at a time</span>
    {#if previousHref}
      <a aria-label="Previous task" class={`wt-button ${threadStyles.button}`} href={previousHref}>←</a>
    {:else}
      <button aria-label="Previous task" class={`wt-button ${threadStyles.button}`} disabled type="button">←</button>
    {/if}
    {#if nextHref}
      <a aria-label="Next task" class={`wt-button ${threadStyles.button}`} href={nextHref}>→</a>
    {:else}
      <button aria-label="Next task" class={`wt-button ${threadStyles.button}`} disabled type="button">→</button>
    {/if}
  </div>
</nav>
<header class={`wt-task-head ${threadStyles.taskHead}`}>
  <div>
    <p class={`wt-id ${threadStyles.id}`}>
      Task {thread.threadId.slice(-4)} · Since {threadDate(row.firstActivityAt, timeZone)}
    </p>
    <h1 class={threadStyles.taskHeading} data-title-length={thread.title.length > 90 ? 'long' : 'normal'}>
      {thread.title}
    </h1>
    {#if thread.objective}
      <p class={`wt-subtitle ${threadStyles.subtitle}`}>{thread.objective}</p>
    {/if}
  </div>
  <div class={`wt-follow-controls ${threadStyles.followControls}`}>
    <span class={`wt-follow-state ${threadStyles.followState}`} data-follow-state={thread.followState}
      >{followLabel}</span
    >
    {#if thread.followState === 'waiting'}
      <button
        class={`wt-button ${threadStyles.button}`}
        disabled={busy}
        onclick={() => setFollowState('following')}
        type="button"
      >
        Resume following
      </button>
    {/if}
    <button
      class={`wt-button ${threadStyles.button}`}
      disabled={busy}
      onclick={() => (thread.followState === 'done' ? setFollowState('following') : end())}
      type="button"
    >
      {thread.followState === 'done' ? 'Reopen' : 'End follow-up'}
    </button>
  </div>
</header>
<WorkThreadSources now={data.generatedAt} sources={taskSourceStatuses(data)} {timeZone} />

{#if thread.followState === 'done'}
  <div class={`wt-done-banner ${threadStyles.doneBanner}`}>
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
<section aria-label="What's left" class={`wt-reason ${threadStyles.reason}`}>
  <div class={`wt-reason-main ${threadStyles.reasonMain}`}>
    <div>
      <p class={`wt-eyebrow ${threadStyles.eyebrow}`}>What's left</p>
      <h2 class={threadStyles.heading2}>{situation.headline}</h2>
      <p class={`wt-subtitle ${threadStyles.subtitle}`}>{situation.caption}</p>
    </div>
    <div class={`wt-actions ${threadStyles.actions}`}>
      {#if situation.action === 'open-pr' && openPr}
        <a
          class={`wt-button wt-primary ${threadStyles.primaryButton}`}
          href={openPr}
          rel="noopener noreferrer"
          target="_blank"
          >Open PR on GitHub ↗</a
        >
      {:else}
        <button
          class={`wt-button wt-primary ${threadStyles.primaryButton}`}
          disabled={busy}
          onclick={primary}
          type="button"
        >
          {primaryLabel}
        </button>
      {/if}
      {#if thread.followState === 'following'}
        <button
          class={`wt-link ${threadStyles.link}`}
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
    <p class={`wt-meta ${threadStyles.meta}`}>
      Copies a verified resume command and context. Nothing is executed here.
    </p>
  {/if}
  {#if panel === 'end'}
    <div class={`wt-inline-panel ${threadStyles.inlinePanel}`}>
      <h3 class={threadStyles.heading3}>These remainders will stay</h3>
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
      <label class={`wt-field ${threadStyles.field}`}
        >Reason (optional)<textarea
          class={`wt-input ${threadStyles.input}`}
          maxlength="512"
          bind:value={reason}
        ></textarea></label
      >
      <div class={`wt-actions ${threadStyles.actions}`}>
        <button
          class={`wt-button wt-primary ${threadStyles.primaryButton}`}
          disabled={busy}
          onclick={() => setFollowState('done')}
          type="button"
        >
          End anyway
        </button><button class={`wt-button ${threadStyles.button}`} onclick={() => (panel = null)} type="button">
          Keep following
        </button>
      </div>
    </div>
  {:else if panel === 'wait'}
    <form
      class={`wt-inline-panel ${threadStyles.inlinePanel}`}
      onsubmit={(event) => {
        event.preventDefault();
        if (waitingFor.trim()) {
          setFollowState('waiting');
        }
      }}
    >
      <label class={`wt-field ${threadStyles.field}`}
        >Waiting for<input
          class={`wt-input ${threadStyles.input}`}
          maxlength="256"
          placeholder="For example, PR review"
          required
          bind:value={waitingFor}
        ></label
      >
      {#if reviewPrs.length}
        <label class={`wt-field ${threadStyles.field}`}
          >Linked PR review (optional)<select class={`wt-input ${threadStyles.input}`} bind:value={waitPrKey}>
            <option value="">No specific source</option>
            {#each reviewPrs as marker}
              <option value={marker.key}>{marker.key}</option>
            {/each}
          </select></label
        >
      {/if}
      <div class={`wt-actions ${threadStyles.actions}`}>
        <button
          class={`wt-button wt-primary ${threadStyles.primaryButton}`}
          disabled={busy || !waitingFor.trim()}
          type="submit"
        >
          Wait
        </button><button class={`wt-button ${threadStyles.button}`} onclick={() => (panel = null)} type="button">
          Cancel
        </button>
      </div>
    </form>
  {/if}
</section>
{#if actionError}
  <div class={`wt-alert ${threadStyles.alert}`} role="alert">
    {actionError}
    {#if retry}
      <button class={`wt-button ${threadStyles.button}`} disabled={busy} onclick={retry} type="button">
        Retry action
      </button>
    {/if}
  </div>
{/if}
<WorkThreadMarkers
  analysisOnly={thread.intent === 'analysis'}
  markers={threadDisplayMarkers(row)}
  now={data.generatedAt}
  {timeZone}
/>

<section aria-labelledby="work-thread-history-title" class={`wt-history ${threadStyles.history}`}>
  <div class={`wt-history-top ${threadStyles.historyTop}`}>
    <h2 class={threadStyles.heading2} id="work-thread-history-title">The thread of this task</h2>
    <div class={`wt-history-controls ${threadStyles.historyControls}`}>
      <fieldset aria-label="History filter" class={`wt-mini-tabs ${threadStyles.miniTabs}`}>
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
      <label class={`wt-switch ${threadStyles.switch}`}
        ><input type="checkbox" bind:checked={showDelegations}>
        Show delegations</label
      >
    </div>
  </div>
  <div class={`wt-journal ${threadStyles.journal}`}>
    {#each history as day (day.key)}
      <section
        aria-label={day.key}
        class={selectedDay === day.key ? threadStyles.selectedDay : undefined}
        id={`work-day-${day.key}`}
        class:wt-selected-day={selectedDay === day.key}
      >
        <h3 class={`wt-day-label ${threadStyles.dayLabel}`}>
          {threadDate(day.entries[0]?.at ?? `${day.key}T12:00:00Z`, timeZone, true)}
        </h3>
        {#each day.entries as entry (entry.id)}
          <div class={`wt-entry ${threadStyles.entry}`}>
            <time class={`wt-entry-time ${threadStyles.entryTime}`} datetime={entry.at}
              >{threadTime(entry.at, timeZone)}</time
            >
            <div class={`wt-entry-body ${threadStyles.entryBody}`}>
              {#if entry.kind === 'session'}
                <WorkThreadEpisode
                  {busy}
                  episode={entry.episode}
                  initiallyOpen={selectedDay === day.key}
                  {linkedKeys}
                  onCopy={copy}
                  onDetach={detach}
                  {showDelegations}
                  taskTitle={thread.title}
                  {timeZone}
                />
              {:else if entry.kind === 'fact-event'}
                {@const factCopy = threadFactEventCopy(entry.event)}
                <div class={`wt-event wt-fact-event ${threadStyles.event}`}>
                  <span class={`wt-event-source ${threadStyles.eventSource}`}>GitHub</span>
                  <div>
                    <strong>{factCopy.title}</strong>
                    {#if factCopy.detail}
                      <p title={entry.event.key}>{factCopy.detail}</p>
                    {/if}
                  </div>
                </div>
              {:else}
                {@const eventCopy = threadEventCopy(entry.event, data.episodes)}
                <div class={`wt-event ${threadStyles.event}`}>
                  <span class={`wt-event-source ${threadStyles.eventSource}`}>{threadEventActor(entry.event)}</span>
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
      <p class={`wt-empty ${threadStyles.empty}`}>
        {sessionsOnly ? 'No linked sessions. A task can exist without a local session.' : 'No history observed yet.'}
      </p>
    {/each}
  </div>
</section>
<div class={`wt-minor-ops ${threadStyles.minorOps}`}>
  <span
    >{row.sessionCount}
    linked {row.sessionCount === 1 ? 'session' : 'sessions'}
    {row.delegatedSessionCount > 0 ? ` · ${row.delegatedSessionCount} delegated` : ''}
    · one task</span
  ><button
    class={`wt-link ${threadStyles.link}`}
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
  <section aria-label="Link an earlier session" class={`wt-inline-panel ${threadStyles.inlinePanel}`}>
    <h3 class={threadStyles.heading3}>Recent sessions · {thread.projectLabel ?? 'No project'}</h3>
    <p>Only served sessions from this project are shown. Linking adds them to this task.</p>
    {#if sessionsError}
      <p role="alert">{sessionsError}</p>
    {:else if sessionsLoading && !sessionChoices.length}
      <p role="status">Reading recent sessions…</p>
    {/if}
    <div class={`wt-session-choices ${threadStyles.sessionChoices}`}>
      {#each sessionChoices.filter((choice) => !linkedKeys.includes(choice.key)) as choice (choice.key)}
        <div class={`wt-session-choice ${threadStyles.sessionChoice}`}>
          <span><strong>{choice.title}</strong><small>{choice.caption}</small></span
          ><button
            aria-label={`Link ${choice.title}`}
            class={`wt-button ${threadStyles.button}`}
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
    <div class={`wt-actions ${threadStyles.actions}`}>
      {#if moreSessions}
        <button
          class={`wt-button ${threadStyles.button}`}
          disabled={sessionsLoading}
          onclick={onMoreSessions}
          type="button"
        >
          Load more sessions
        </button>
      {/if}
      <button class={`wt-button ${threadStyles.button}`} onclick={() => (panel = null)} type="button">Cancel</button>
    </div>
  </section>
{/if}
{#if data.detachedLinks.some((link) => link.kind === 'session')}
  <details class={`wt-detached ${threadStyles.detached}`}>
    <summary>Detached sessions</summary>
    {#each data.detachedLinks.filter((link) => link.kind === 'session') as link}
      <div class={`wt-session-choice ${threadStyles.sessionChoice}`}>
        <span>{link.key}</span
        ><button
          class={`wt-link ${threadStyles.link}`}
          disabled={busy}
          onclick={() => linkSession(link.key)}
          type="button"
        >
          Link again
        </button>
      </div>
    {/each}
  </details>
{/if}
<details class={`wt-note ${threadStyles.note}`}>
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
    <label class={`wt-field ${threadStyles.field}`}
      >Resume note<textarea
        class={`wt-input ${threadStyles.input}`}
        maxlength="2000"
        oninput={(event) => (note = event.currentTarget.value)}
        value={note ?? thread.note ?? ''}
      ></textarea></label
    ><button class={`wt-button ${threadStyles.button}`} disabled={busy} type="submit">Save note</button>
  </form>
</details>
{#if toast}
  <div class={`wt-toast ${threadStyles.toast}`} role="status">
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
