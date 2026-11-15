<script lang="ts">
  import WorkMilestoneGlyph from './work-milestone-glyph.svelte';
  import { harnessGlyph } from './work-thread-model';
  import type { TimelinePullRequestBar, TimelineScale, TimelineSessionBar, TimelineTrack } from './work-timeline-model';

  /** Beyond this many columns a cell is too narrow for its count; the level alone carries it. */
  const PRINTED_COUNT_MAX_COLUMNS = 62;
  /** The accessible name stays a sentence: later session spans are counted, not read out. */
  const DESCRIBED_SESSION_BARS = 12;

  let {
    track,
    scale,
    labels = false,
    milestones = false,
    sessions = null,
  }: {
    track: TimelineTrack;
    scale: TimelineScale;
    /** Print each pull request's number beside its bar. */
    labels?: boolean;
    /** Draw each pull request's milestones on its bar. */
    milestones?: boolean;
    /** Hour resolution: the task's session spans replace the heat row. */
    sessions?: { readonly bars: readonly TimelineSessionBar[]; readonly rows: number } | null;
  } = $props();

  const printed = $derived(scale.columns.length <= PRINTED_COUNT_MAX_COLUMNS);
  const percent = (fraction: number): string => `${Number((fraction * 100).toFixed(3))}%`;
  const span = (start: number, end: number, minimum: number): string =>
    `left: ${percent(start)}; width: max(${percent(end - start)}, ${minimum}px)`;
  const summary = $derived.by(() => {
    if (!sessions || sessions.bars.length === 0) {
      return track.summary;
    }
    const described = sessions.bars.slice(0, DESCRIBED_SESSION_BARS).map((bar) => bar.description);
    const more = sessions.bars.length - described.length;
    return `${track.summary} Session spans: ${described.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
  });
  // A bar that ends near the right edge has no room after it: its number goes before, or over it.
  const labelStyle = (bar: TimelinePullRequestBar): string => {
    if (bar.end <= 0.88) {
      return `left: calc(${percent(bar.end)} + 9px)`;
    }
    if (bar.start >= 0.08) {
      return `right: calc(${percent(1 - bar.start)} + 5px)`;
    }
    return 'left: 4px';
  };
</script>

<div
  aria-label={summary}
  class="wtl-track"
  data-resolution={scale.resolution}
  role="img"
  style={`--wtl-cols: ${scale.columns.length}; --wtl-pr-rows: ${track.pullRequestRows}; --wtl-session-rows: ${Math.max(sessions?.rows ?? 0, 1)}`}
>
  {#if sessions}
    <div aria-hidden="true" class="wtl-sessions">
      {#each sessions.bars as bar (bar.key)}
        <span
          class="wtl-session"
          data-harness={bar.harness}
          style={`--wtl-row: ${bar.row}; ${span(bar.start, bar.end, 3)}`}
          title={bar.description}
          class:wtl-ends-after={bar.endsAfter}
          class:wtl-point={bar.point}
          class:wtl-starts-before={bar.startsBefore}
        >
          {#if !bar.point}
            <span class="wtl-session-glyph">{harnessGlyph(bar.harness)}</span>
          {/if}
        </span>
        {#each bar.children as child (child.key)}
          <span
            class="wtl-child"
            data-harness={child.harness}
            style={`--wtl-row: ${bar.row}; ${span(child.start, child.end, 2)}`}
            title={child.description}
          ></span>
        {/each}
      {/each}
    </div>
  {:else}
    <div aria-hidden="true" class="wtl-heat" class:wtl-dense={!printed}>
      {#each scale.columns as column, index (column.key)}
        {@const count = track.heat[index]?.count ?? 0}
        <span
          class="wtl-cell"
          data-level={track.heat[index]?.level ?? 0}
          title={`${column.label}: ${count} ${count === 1 ? 'session' : 'sessions'} started`}
          class:wtl-major={column.major}
          class:wtl-today={column.today}
          >{#if printed && count > 0}
            {count}
          {/if}</span
        >
      {/each}
    </div>
  {/if}
  {#if track.pullRequests.length > 0}
    <div aria-hidden="true" class="wtl-prs">
      {#each track.pullRequests as bar (bar.key)}
        <span
          class="wtl-pr"
          data-checks={bar.checks}
          data-tone={bar.tone}
          style={`--wtl-row: ${bar.row}; ${span(bar.start, bar.end, 6)}`}
          title={bar.description}
          class:wtl-ends-after={bar.endsAfter}
          class:wtl-open={bar.open}
          class:wtl-starts-before={bar.startsBefore}
        ></span>
        {#if labels}
          <span class="wtl-pr-label" style={`--wtl-row: ${bar.row}; ${labelStyle(bar)}`}>{bar.label}</span>
        {/if}
        {#if milestones}
          {#each bar.milestones as milestone}
            <span
              class="wtl-pr-milestone"
              data-milestone={milestone.kind}
              style={`--wtl-row: ${bar.row}; left: ${percent(milestone.at)}`}
              title={milestone.label}
              ><WorkMilestoneGlyph kind={milestone.kind} size={10} /></span
            >
          {/each}
        {/if}
      {/each}
    </div>
  {/if}
  {#if track.hiddenPullRequests > 0}
    <span aria-hidden="true" class="wtl-pr-more"
      >+{track.hiddenPullRequests} {track.hiddenPullRequests === 1 ? 'PR' : 'PRs'}</span
    >
  {/if}
</div>
