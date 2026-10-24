<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type { WorkThreadEpisode } from '@ai-usage/report-core/work-thread-view';
  import { untrack } from 'svelte';
  import Episode from './work-thread-episode.svelte';
  import {
    episodeContext,
    episodeResumeText,
    episodeSpan,
    harnessGlyph,
    harnessName,
    threadTime,
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
  const resume = $derived(episodeResumeText(episode, taskTitle));
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
    onclick={() => expanded = !expanded}
    type="button"
  >
    <span class="wt-glyph" data-harness={episode.harness}>{harnessGlyph(episode.harness)}</span>
    <span class="wt-session-label"
      ><strong>{episode.title ?? 'Untitled session'}</strong
      ><small
        >{harnessName(episode.harness)}
        · {who} · {threadTime(episode.startedAt, timeZone)}
        {episode.endedAt ? `–${threadTime(episode.endedAt, timeZone)}` : ''}{episode.running ? ' · Running' : ''}</small
      ></span
    >
    <span class="wt-duration" title="Episode span: first to last observed activity; may include pauses"
      ><span class="wt-sr">Episode span: </span>{episodeSpan(episode)}</span
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
        Episode span is first to last observed activity and may include pauses. It is not human working time.
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
      aria-expanded={showDelegations || childrenOpen ? 'true' : 'false'}
      class="wt-delegations"
      onclick={() => childrenOpen = !childrenOpen}
      type="button"
    >
      + {episode.children.length} delegated {episode.children.length === 1 ? 'session' : 'sessions'}
    </button>
    {#if showDelegations || childrenOpen}
      <div class="wt-children">
        {#each episode.children as child (child.linkKey)}
          <Episode {busy} episode={child} {linkedKeys} {onCopy} {onDetach} {showDelegations} {taskTitle} {timeZone} />
        {/each}
      </div>
    {/if}
  {/if}
</div>
