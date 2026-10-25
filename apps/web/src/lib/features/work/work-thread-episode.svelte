<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type { WorkThreadEpisode } from '@ai-usage/report-core/work-thread-view';
  import { untrack } from 'svelte';
  import Episode from './work-thread-episode.svelte';
  import {
    episodeContext,
    episodeDuration,
    episodeDurationDetail,
    episodeResumeText,
    episodeSpan,
    episodeSpanContext,
    harnessGlyph,
    harnessName,
    threadTime,
  } from './work-thread-model';
  import { threadStyles } from './work-thread-styles';

  let {
    episode,
    taskTitle,
    timeZone,
    showDelegations,
    onCopy,
    onDetach,
    linkedKeys,
    busy = false,
    initiallyOpen = false,
  }: {
    episode: WorkThreadEpisode;
    taskTitle: string;
    timeZone: string;
    showDelegations: boolean;
    onCopy: (text: string, message: string) => void;
    onDetach: (key: string) => void;
    linkedKeys: readonly string[];
    busy?: boolean;
    initiallyOpen?: boolean;
  } = $props();
  let expanded = $state(untrack(() => initiallyOpen));
  let childrenOpen = $state(false);
  const resume = $derived(episodeResumeText(episode, taskTitle));
  const spanContext = $derived(episodeSpanContext(episode));
  const who = $derived(
    episode.origin
      ? { human: 'You', delegated: 'Delegated', 'automated-review': 'Automated review' }[episode.origin]
      : 'Origin not declared',
  );
</script>

<div class="wt-episode" data-session-key={episode.linkKey}>
  <button
    aria-expanded={expanded ? 'true' : 'false'}
    class={`wt-session-button ${threadStyles.sessionButton}`}
    onclick={() => (expanded = !expanded)}
    type="button"
  >
    <span class={`wt-glyph ${threadStyles.glyph}`} data-harness={episode.harness}>{harnessGlyph(episode.harness)}</span>
    <span class={`wt-session-label ${threadStyles.sessionLabel}`}
      ><strong>{episode.title ?? 'Untitled session'}</strong
      ><small
        >{harnessName(episode.harness)}
        · {who} · {threadTime(episode.startedAt, timeZone)}
        {episode.endedAt ? `–${threadTime(episode.endedAt, timeZone)}` : ''}{spanContext
          ? ` · ${spanContext}`
          : ''}{episode.running ? ' · Running' : ''}</small
      ></span
    >
    <span class={`wt-duration ${threadStyles.duration}`} title={episodeDurationDetail(episode)}
      ><span class={`wt-sr ${threadStyles.sr}`}
        >{episode.activeMs === null ? 'Duration not recorded: ' : 'Recorded for this episode: '}</span
      >{episodeDuration(episode)}</span
    >
    <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
  </button>
  {#if episode.result}
    <p class={`wt-session-result ${threadStyles.sessionResult}`}>{episode.result}</p>
  {/if}
  {#if expanded}
    <div class={`wt-inspector ${threadStyles.inspector}`}>
      <dl class={`wt-context ${threadStyles.context}`}>
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
          <dd>{episode.question ?? 'No question observed'}</dd>
        </div>
        {#if episode.launchedBy}
          <div>
            <dt>Launched by</dt>
            <dd>{harnessName(episode.launchedBy.harness)} · {episode.launchedBy.title ?? 'Untitled session'}</dd>
          </div>
        {/if}
      </dl>
      <p class={`wt-meta ${threadStyles.meta}`}>
        {episodeDurationDetail(episode)}
      </p>
      <p class={`wt-meta ${threadStyles.meta}`}>
        {episodeSpan(episode)}
        · first to last activity, pauses included. It is not human working time.
      </p>
      {#if episode.resume.kind === 'cli-resume'}
        <code class={`wt-code ${threadStyles.code}`}>{episode.resume.command}</code>
        {#if episode.resume.cwd}
          <p class={`wt-meta ${threadStyles.meta}`}>Working directory: {episode.resume.cwd}</p>
        {/if}
        <p class={`wt-meta ${threadStyles.meta}`}>
          Resume this session copies the verified command and context. Run the command in your terminal; nothing is
          executed here.
        </p>
      {:else}
        <p class={`wt-meta ${threadStyles.meta}`}>Resume unavailable: {episode.resume.reason}</p>
      {/if}
      <div class={`wt-actions ${threadStyles.actions}`}>
        {#if resume}
          <button
            class={`wt-button wt-primary ${threadStyles.primaryButton}`}
            onclick={() => onCopy(resume, 'Resume command and context copied — nothing was executed')}
            type="button"
          >
            Resume this session
          </button>
        {/if}
        <button
          class={`wt-button ${threadStyles.button}`}
          onclick={() => onCopy(episodeContext(episode, taskTitle), 'Session context copied')}
          type="button"
        >
          Copy context
        </button>
        {#if linkedKeys.includes(episode.linkKey)}
          <button
            class={`wt-link ${threadStyles.link}`}
            disabled={busy}
            onclick={() => onDetach(episode.linkKey)}
            type="button"
          >
            Detach session
          </button>
        {/if}
      </div>
    </div>
  {/if}
  {#if episode.children.length}
    <button
      aria-expanded={showDelegations || childrenOpen ? 'true' : 'false'}
      class={`wt-delegations ${threadStyles.delegations}`}
      onclick={() => (childrenOpen = !childrenOpen)}
      type="button"
    >
      {showDelegations || childrenOpen ? '−' : '+'} {episode.children.length} delegated
      {episode.children.length === 1 ? 'session' : 'sessions'}
    </button>
    {#if showDelegations || childrenOpen}
      <div class={`wt-children ${threadStyles.children}`}>
        {#each episode.children as child (child.linkKey)}
          <Episode {busy} episode={child} {linkedKeys} {onCopy} {onDetach} {showDelegations} {taskTitle} {timeZone} />
        {/each}
      </div>
    {/if}
  {/if}
</div>
