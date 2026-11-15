<script lang="ts">
  import type { WorkThreadLink } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadEpisode } from '@ai-usage/report-core/work-thread-view';
  import {
    episodeContext,
    episodeDurationDetail,
    episodeResumeText,
    episodeSpan,
    episodeTimeRange,
    harnessName,
  } from './work-thread-model';

  /** What one session left and how to resume it; shared by the journal and the cascade. */
  let {
    episode,
    taskTitle,
    timeZone,
    onCopy,
    onDetach,
    linkedKeys,
    links = [],
    busy = false,
    nested = false,
  }: {
    episode: WorkThreadEpisode;
    taskTitle: string;
    timeZone: string;
    onCopy: (text: string, message: string) => void;
    onDetach: (key: string) => void;
    linkedKeys: readonly string[];
    links?: readonly WorkThreadLink[];
    busy?: boolean;
    /** Shown under the session that declared it, not as a session of the task itself. */
    nested?: boolean;
  } = $props();
  const resume = $derived(episodeResumeText(episode, taskTitle));
</script>

<div class="wt-inspector">
  <dl class="wt-context">
    <div>
      <dt>Linked because</dt>
      <dd>
        {#if links.find((link) => link.key === episode.linkKey)?.provenance === 'user'}
          You linked this session
        {:else if links.some((link) => link.key === episode.linkKey)}
          Recorded task association
        {:else if nested}
          Delegated by a linked session
        {:else}
          Recorded on a branch of this task
        {/if}
      </dd>
    </div>
    <div>
      <dt>Activity range</dt>
      <dd>{episodeTimeRange(episode, timeZone)}</dd>
    </div>
    <div>
      <dt>Initial request</dt>
      <dd>{episode.firstPrompt ?? 'Not observed'}</dd>
    </div>
    <div>
      <dt>Last instruction</dt>
      <dd>{episode.lastInstruction ?? 'Not observed'}</dd>
    </div>
    <div>
      <dt>What the session left</dt>
      <dd>{episode.result ?? 'No result observed'}</dd>
    </div>
    <div>
      <dt>Current question</dt>
      <dd>
        {#each episode.nativeRequests as request (request.key)}
          <p>{request.text} · {request.state}<br>{request.detail}</p>
        {:else}
          No question observed; request coverage may be incomplete.
        {/each}
      </dd>
    </div>
    {#if episode.launchedBy}
      <div>
        <dt>Launched by</dt>
        <dd>{harnessName(episode.launchedBy.harness)} · {episode.launchedBy.title ?? 'Untitled session'}</dd>
      </div>
    {/if}
  </dl>
  <p class="wt-meta">
    {episodeDurationDetail(episode)}
  </p>
  <p class="wt-meta">{episodeSpan(episode)} · first to last activity, pauses included. It is not human working time.</p>
  {#if episode.resume.kind === 'cli-resume'}
    <code class="wt-code">{episode.resume.command}</code>
    {#if episode.resume.cwd}
      <p class="wt-meta">Working directory: {episode.resume.cwd}</p>
    {/if}
    <p class="wt-meta">
      Resume this session copies the verified command and context. Run the command in your terminal; nothing is executed
      here.
    </p>
  {:else}
    <p class="wt-meta">Resume unavailable: {episode.resume.reason}</p>
  {/if}
  <div class="wt-actions">
    {#if resume}
      <button
        class="wt-button wt-primary"
        onclick={() => onCopy(resume, 'Resume command and context copied — nothing was executed')}
        type="button"
      >
        Resume this session
      </button>
    {/if}
    <button
      class="wt-button"
      onclick={() => onCopy(episodeContext(episode, taskTitle), 'Session context copied')}
      type="button"
    >
      Copy context
    </button>
    {#if linkedKeys.includes(episode.linkKey)}
      <button class="wt-link" disabled={busy} onclick={() => onDetach(episode.linkKey)} type="button">
        Detach session
      </button>
    {/if}
  </div>
</div>
