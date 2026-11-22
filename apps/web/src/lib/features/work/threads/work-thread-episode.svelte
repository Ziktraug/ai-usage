<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<script lang="ts">
  import type { WorkThreadLink } from '@ai-usage/report-core/work-thread';
  import type { WorkThreadEpisode } from '@ai-usage/report-core/work-thread-view';
  import { untrack } from 'svelte';
  import {
    episodeDuration,
    episodeDurationDetail,
    episodeSpanContext,
    episodeTimeRange,
    harnessName,
  } from '../work-thread-model';
  import WorkHarnessGlyph from './work-harness-glyph.svelte';
  import Episode from './work-thread-episode.svelte';
  import WorkThreadEpisodeDetail from './work-thread-episode-detail.svelte';

  let {
    episode,
    taskTitle,
    timeZone,
    showDelegations,
    onCopy,
    onDetach,
    linkedKeys,
    links = [],
    busy = false,
    initiallyOpen = false,
    nested = false,
  }: {
    episode: WorkThreadEpisode;
    taskTitle: string;
    timeZone: string;
    showDelegations: boolean;
    onCopy: (text: string, message: string) => void;
    onDetach: (key: string) => void;
    linkedKeys: readonly string[];
    links?: readonly WorkThreadLink[];
    busy?: boolean;
    initiallyOpen?: boolean;
    nested?: boolean;
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
    <span class="wt-glyph" data-harness={episode.harness}><WorkHarnessGlyph harness={episode.harness} /></span>
    <span class="wt-session-label"
      ><strong>{episode.title ?? 'Untitled session'}</strong
      ><small
        >{harnessName(episode.harness)}
        · {who} · {episodeTimeRange(episode, timeZone)}{spanContext ? ` · ${spanContext}` : ''}{episode.running
          ? ' · Running'
          : ''}</small
      ></span
    >
    {#if episode.activeMs !== null}
      <span class="wt-duration" title={episodeDurationDetail(episode)}
        ><span class="wt-sr"
          >{episode.activeMs === null ? 'Duration not recorded: ' : 'Recorded for this episode: '}</span
        >{episodeDuration(episode)}</span
      >
    {/if}
    <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
  </button>
  {#if expanded}
    <WorkThreadEpisodeDetail
      {busy}
      {episode}
      {linkedKeys}
      {links}
      {nested}
      {onCopy}
      {onDetach}
      {taskTitle}
      {timeZone}
    />
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
          <Episode
            {busy}
            episode={child}
            {linkedKeys}
            {links}
            nested
            {onCopy}
            {onDetach}
            {showDelegations}
            {taskTitle}
            {timeZone}
          />
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
