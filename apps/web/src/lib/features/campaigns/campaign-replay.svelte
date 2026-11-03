<script lang="ts">
  import { ghostButton } from '@ai-usage/design-system/report';
  import type { CampaignMap } from '@ai-usage/report-core/campaign-map';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { createQuery } from '@tanstack/svelte-query';
  import { browser } from '$app/env';
  import { graphTheme } from '../../foundation/presentation/graph-theme';
  import { optionalSessionDetailQueryOptions } from '../../query/options/session';
  import type { SessionClientAdapter } from '../../rpc/session-client';
  import { campaignReplay, replayNativeDetail, replayPhase } from './campaign-replay-model';

  let {
    map,
    revision,
    client,
    onOpen,
  }: {
    map: CampaignMap;
    revision: string;
    client: SessionClientAdapter;
    onOpen: (row: SessionPresentationRow) => void;
  } = $props();
  const replay = $derived(campaignReplay(map));
  const from = $derived(replay.from ?? 0);
  const to = $derived(replay.to ?? from);
  const duration = $derived(to - from);
  let offset = $state(0);
  let playing = $state(false);
  let speed = $state(60);
  let selectedId = $state('');
  const cursor = $derived(from + Math.min(duration, offset));
  const selected = $derived(replay.nodes.find((node) => node.row.rowId === selectedId) ?? replay.nodes[0]);
  const detailQuery = createQuery(() =>
    optionalSessionDetailQueryOptions(client, selected ? { revision, rowId: selected.row.rowId } : undefined, {
      browser,
    }),
  );
  const response = $derived(detailQuery.data);
  const detail = $derived(response?.status === 'available' && response.revision === revision ? response.detail : null);
  const native = $derived(detail ? replayNativeDetail(detail, cursor) : null);
  const coverageLabels = {
    childDiscovery: 'Child discovery',
    grouping: 'Round grouping',
    promptBodies: 'Prompt text',
    interactionAttribution: 'Interaction attribution',
    recordedTiming: 'Timing',
  };
  const labels = {
    before: 'Before recorded start',
    'observed-span': 'Inside recorded span',
    after: 'Recorded end reached',
    'timing-unavailable': 'Timing incomplete',
  };
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const percent = (ms: number) => (duration ? Math.max(0, Math.min(100, ((ms - from) / duration) * 100)) : 0);
  $effect(() => {
    if (!playing || duration <= 0) {
      return;
    }
    const rate = speed;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      offset = Math.min(duration, offset + (now - previous) * rate);
      previous = now;
      if (offset >= duration) {
        playing = false;
      }
    }, 100);
    return () => clearInterval(timer);
  });
</script>
<section aria-label="Campaign replay" class={`replay ${graphTheme}`}>
  <h2>Replay · {map.title}</h2>
  <p class="muted">
    {replay.nodes.length}
    of {map.totalCount} sessions shown; {replay.omitted} omitted. Recorded session spans include idle gaps. Playback
    uses elapsed wall time, not CPU time or current activity. Native rounds and events below cover only the selected
    session.
  </p>
  {#if !map.timingComplete}
    <p role="status">Campaign timing is incomplete. Missing endpoints are never extended to the cursor.</p>
  {/if}
  {#if replay.from !== null}
    <p>
      <time datetime={new Date(cursor).toISOString()}>{new Date(cursor).toISOString()}</time>
      · {Math.floor((cursor - from) / 1000)} s elapsed
    </p>
    <div class="controls">
      <button
        class={ghostButton}
        disabled={duration <= 0}
        onclick={() => {
          if (offset >= duration) {
            offset = 0;
          }
          playing = !playing;
        }}
        type="button"
      >
        {playing ? 'Pause replay' : 'Play replay'}
      </button>
      <button
        class={ghostButton}
        onclick={() => {
          playing = false;
          offset = 0;
        }}
        type="button"
      >
        Restart replay
      </button>
      <label
        >Speed<select bind:value={speed}>
          <option value={1}>1×</option>
          <option value={60}>60×</option>
          <option value={600}>600×</option>
        </select></label
      >
      <label class="seek"
        >Elapsed time<input
          aria-label="Replay elapsed time"
          disabled={duration <= 0}
          max={duration}
          min="0"
          oninput={() => (playing = false)}
          step="1000"
          type="range"
          bind:value={offset}
        ></label
      >
    </div>
  {:else}
    <p role="status">No recorded timestamps are available for playback.</p>
  {/if}
  <label class="selection"
    >Inspect session<select aria-label="Replay session" bind:value={selectedId}>
      <option value="">{replay.nodes[0]?.title ?? 'No session'}</option>
      {#each replay.nodes as node (node.row.rowId)}
        <option value={node.row.rowId}>{node.title}</option>
      {/each}
    </select></label
  >
  <div class="sessions">
    {#each replay.nodes as node (node.row.rowId)}
      {@const parent = map.nodes.find((candidate) => candidate.row.rowId === node.parentRowId)}
      <button
        aria-pressed={node.row.rowId === selected?.row.rowId}
        class="session"
        onclick={() => (selectedId = node.row.rowId)}
        type="button"
        class:selected={node.row.rowId === selected?.row.rowId}
      >
        <span
          >{node.title}
          <small
            >{#if parent}
              Declared parent: {parent.title}
            {:else if node.relationship === 'root'}
              Campaign root
            {:else}
              Parent unresolved
            {/if}</small
          ></span
        >
        <span aria-hidden="true" class="track">
          {#if node.timingStatus === 'recorded' && node.startMs !== null && node.endMs !== null}
            <span
              class="bar"
              style:left={`${percent(node.startMs)}%`}
              style:width={`${Math.max(0.2, percent(node.endMs) - percent(node.startMs))}%`}
            ></span>
          {/if}
          <span class="cursor" style:left={`${percent(cursor)}%`}></span>
        </span>
        <small>{labels[replayPhase(node, cursor)]}</small>
      </button>
    {/each}
  </div>
  {#if selected}
    <section aria-label="Selected session events" class="native">
      <h3>{selected.title}</h3>
      <button
        class={ghostButton}
        onclick={() => {
          playing = false;
          onOpen(selected.row);
        }}
        type="button"
      >
        Open selected session details
      </button>
      {#if detailQuery.error}
        <p role="alert">Could not read native events: {detailQuery.error.message}</p>
        <button class={ghostButton} onclick={() => detailQuery.refetch()} type="button">Retry native events</button>
      {:else if response?.status === 'unavailable'}
        <p role="status">Native events unavailable: {response.message}</p>
      {:else if detail && native}
        <p class="muted">
          Native history observed {detail.observedAt}. {native.startedRounds} of {native.totalRounds} rounds have a
          recorded start at or before the cursor. Round boundaries are observed spans, not continuous activity.
        </p>
        {#if response?.status === 'available' && response.consistency.status !== 'matches-report'}
          <p role="status">
            Native detail
            {response.consistency.status === 'differs-from-report' ? 'differs from' : 'cannot be compared with'}
            this report revision. No report totals are recomputed.
          </p>
        {/if}
        {#each Object.entries(detail.coverage) as [key, fact] (key)}
          {#if fact.status !== 'complete'}
            <p class="muted">
              {coverageLabels[key as keyof typeof coverageLabels]}: {fact.status};
              {fact.omittedCount ?? 'unknown'}
              omitted.
              {fact.reasons.map((reason: string) => reason.replaceAll('-', ' ')).join(', ')}
            </p>
          {/if}
        {/each}
        {#if native.round}
          <p>
            Round {native.round.index + 1} ·
            {Date.parse(native.round.endAt) <= cursor ? 'recorded end reached' : 'recorded end not yet reached'}
          </p>
        {/if}
        {#if native.omittedEvents}
          <p role="status">
            Showing the latest {native.events.length} events up to the cursor; {native.omittedEvents} earlier events
            omitted from this view.
          </p>
        {/if}
        <ol class="events">
          {#each native.events as entry (entry.id)}
            <li>
              <time datetime={new Date(entry.at).toISOString()}>{time(entry.at)} UTC</time>
              <strong>{entry.kind}</strong>
              <p>{entry.text}</p>
            </li>
          {:else}
            <li>No recorded native events at or before this time.</li>
          {/each}
        </ol>
      {:else}
        <p role="status">Loading native events for the selected session…</p>
      {/if}
    </section>
  {/if}
</section>
<style>
  .replay {
    display: grid;
    gap: 16px;
    min-width: 0;
    padding: 16px;
    margin-block: 24px;
    border: 1px solid var(--graph-line);
    border-radius: var(--graph-radius-md);
  }
  .muted,
  small {
    font-size: 12px;
    line-height: 1.6;
    color: var(--graph-muted);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }
  label {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  select {
    max-width: 100%;
    padding: 8px;
    color: var(--graph-ink);
    background: var(--graph-surface);
    border: 1px solid var(--graph-line);
  }
  .seek {
    flex: 1;
    min-width: 160px;
  }
  .selection {
    max-width: 100%;
  }
  .sessions {
    display: grid;
    gap: 4px;
    max-height: 440px;
    overflow-y: auto;
  }
  .session {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(80px, 1fr);
    gap: 6px 12px;
    padding: 10px;
    text-align: start;
    border: 1px solid var(--graph-line);
    border-radius: var(--graph-radius-sm);
  }
  .session small {
    display: block;
  }
  .selected {
    border-color: var(--graph-accent);
  }
  .track {
    position: relative;
    align-self: center;
    min-height: 24px;
    overflow: hidden;
    background: var(--graph-track);
  }
  .bar {
    position: absolute;
    top: 7px;
    height: 10px;
    background: var(--graph-accent);
    opacity: 0.5;
  }
  .cursor {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--graph-ink);
  }
  .native {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .events {
    display: grid;
    gap: 12px;
    padding-inline-start: 20px;
  }
  .events p {
    max-height: 200px;
    overflow-y: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .events time {
    font-family: var(--graph-mono);
    font-size: 12px;
  }
</style>
