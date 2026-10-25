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
    episodeTimeRange,
    harnessGlyph,
    harnessName,
  } from './work-thread-model';

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
  let visibleChildCount = $state(5);
  const delegationsExpanded = $derived(showDelegations || childrenOpen);
  $effect(() => {
    if (!delegationsExpanded) {
      visibleChildCount = 5;
    }
  });
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
    class="wt-session-button"
    onclick={() => (expanded = !expanded)}
    type="button"
  >
    <span class="wt-glyph" data-harness={episode.harness}>{harnessGlyph(episode.harness)}</span>
    <span class="wt-session-label"
      ><strong>{episode.title ?? 'Untitled session'}</strong
      ><small
        >{harnessName(episode.harness)}
        · {who} · {episodeTimeRange(episode, timeZone)}{spanContext ? ` · ${spanContext}` : ''}{episode.running
          ? ' · Running'
          : ''}</small
      ></span
    >
    <span class="wt-duration" title={episodeDurationDetail(episode)}
      ><span class="wt-sr"
        >{episode.activeMs === null ? 'Duration not recorded: ' : 'Recorded for this episode: '}</span
      >{episodeDuration(episode)}</span
    >
    <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
  </button>
  {#if episode.result}
    <p class="wt-session-result">{episode.result}</p>
  {/if}
  {#if expanded}
    <div class="wt-inspector">
      <dl class="wt-context">
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
          <dd>{episode.question ?? 'No question observed'}</dd>
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
      <p class="wt-meta">
        {episodeSpan(episode)}
        · first to last activity, pauses included. It is not human working time.
      </p>
      {#if episode.resume.kind === 'cli-resume'}
        <code class="wt-code">{episode.resume.command}</code>
        {#if episode.resume.cwd}
          <p class="wt-meta">Working directory: {episode.resume.cwd}</p>
        {/if}
        <p class="wt-meta">
          Resume this session copies the verified command and context. Run the command in your terminal; nothing is
          executed here.
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
  {/if}
  {#if episode.children.length}
    <button
      aria-expanded={delegationsExpanded ? 'true' : 'false'}
      class="wt-delegations"
      onclick={() => (childrenOpen = !childrenOpen)}
      type="button"
    >
      {delegationsExpanded ? '−' : '+'} {episode.children.length} delegated
      {episode.children.length === 1 ? 'session' : 'sessions'}
    </button>
    {#if delegationsExpanded}
      <div class="wt-children">
        {#each episode.children.slice(0, visibleChildCount) as child (child.linkKey)}
          <Episode {busy} episode={child} {linkedKeys} {onCopy} {onDetach} {showDelegations} {taskTitle} {timeZone} />
        {/each}
        {#if episode.children.length > 5}
          <button
            aria-expanded={visibleChildCount > 5 ? 'true' : 'false'}
            class="wt-delegations"
            onclick={() => (visibleChildCount = visibleChildCount > 5 ? 5 : episode.children.length)}
            type="button"
          >
            {#if visibleChildCount > 5}
              Show fewer delegated sessions
            {:else}
              Show {episode.children.length - visibleChildCount} more delegated
              {episode.children.length - visibleChildCount === 1 ? 'session' : 'sessions'}
            {/if}
          </button>
        {/if}
      </div>
    {/if}
  {/if}
</div>
