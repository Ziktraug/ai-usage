<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed true/false ARIA states; SSR and browser regressions assert their values. -->
<!-- biome-ignore-all lint/a11y/useSemanticElements: the APG tree pattern nests a treeitem's children in role=group; a fieldset is not a valid tree child. -->
<script lang="ts">
  import type { WorkThreadLink } from '@ai-usage/report-core/work-thread';
  import type { Snippet } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import WorkHarnessGlyph from './work-harness-glyph.svelte';
  import WorkMilestoneGlyph from './work-milestone-glyph.svelte';
  import {
    type CascadeAxis,
    type CascadeBlock,
    type CascadeBurstNode,
    type CascadeHistoryEntry,
    type CascadeMark,
    type CascadeMilestone,
    type CascadeRow,
    type CascadeSessionNode,
    type CascadeStretch,
    type CascadeSummary,
    cascadeOffset,
    readsNoParent,
  } from './work-session-cascade';
  import './work-session-cascade.css';
  import WorkThreadEpisodeDetail from './work-thread-episode-detail.svelte';
  import {
    formatEpisodeDuration,
    harnessName,
    threadDate,
    threadDayKey,
    threadEventCopy,
    threadFactEventCopy,
    threadTime,
    threadTimeRange,
  } from './work-thread-model';

  /**
   * The sessions of a task as a trace: one row per session on an hour axis, child sessions under
   * the parent that declared them. Each stretch is a tree (APG pattern): Up and Down move, Right
   * opens a group or enters it, Left closes it or returns to its parent, Enter shows the session.
   * Every bar is decoration; the row's name carries the same times, spans and marks as text.
   */
  let {
    blocks,
    timeZone,
    taskTitle,
    expandAll,
    selectedDay = null,
    linkedKeys,
    links = [],
    busy = false,
    onCopy,
    onDetach,
    historyEntry,
  }: {
    blocks: readonly CascadeBlock[];
    timeZone: string;
    taskTitle: string;
    expandAll: boolean;
    selectedDay?: string | null;
    linkedKeys: readonly string[];
    links?: readonly WorkThreadLink[];
    busy?: boolean;
    onCopy: (text: string, message: string) => void;
    onDetach: (key: string) => void;
    /** How the task detail writes one dated event; the cascade lists them under each stretch. */
    historyEntry: Snippet<[CascadeHistoryEntry]>;
  } = $props();

  const MARK_LABELS: Record<CascadeMark, string> = {
    asks: 'Asks you',
    unclear: 'May be asking',
    running: 'Running',
    'open-ended': 'End not observed',
    // Request coverage can be partial: this says what was read, never that nothing is pending.
    quiet: 'No open request read',
  };
  const MAX_STRIPS = 4;
  const DAY_MS = 86_400_000;

  const opened = new SvelteSet<string>();
  let detailId = $state<string | null>(null);
  let activeId = $state<string | null>(null);
  let root = $state<HTMLElement>();
  const isOpen = (id: string): boolean => expandAll || opened.has(id);
  const ariaExpanded = (expandable: boolean, expanded: boolean): 'true' | 'false' | undefined => {
    if (!expandable) {
      return;
    }
    return expanded ? 'true' : 'false';
  };
  const toggle = (id: string): void => {
    if (opened.has(id)) {
      opened.delete(id);
    } else {
      opened.add(id);
    }
  };

  const duration = (summary: Pick<CascadeSummary, 'spanMs' | 'unknownSpans'>): string => {
    if (summary.spanMs === null) {
      return 'spans not observed';
    }
    const unknown = summary.unknownSpans > 0 ? ` · ${summary.unknownSpans} not observed` : '';
    return `spans sum to ${formatEpisodeDuration(summary.spanMs)}${unknown}`;
  };
  const span = (startMs: number, endMs: number | null): string =>
    endMs === null ? 'end not observed' : formatEpisodeDuration(endMs - startMs);
  const sessions = (count: number): string => `${count} ${count === 1 ? 'session' : 'sessions'}`;
  const children = (count: number): string => `${count} child ${count === 1 ? 'session' : 'sessions'}`;
  const who = (node: CascadeSessionNode): string =>
    node.episode.origin
      ? { human: 'started by you', delegated: 'delegated', 'automated-review': 'automated review' }[node.episode.origin]
      : 'origin not declared';
  const lineage = (node: CascadeSessionNode): string => {
    if (node.episode.launchedBy) {
      return `launched by ${node.episode.launchedBy.title ?? harnessName(node.episode.launchedBy.harness)}`;
    }
    // A delegated session has a parent somewhere; it is only not among this task's sessions.
    return readsNoParent(node.episode) ? 'no parent read' : 'parent not read for this task';
  };
  const range = (startMs: number, endMs: number | null): string =>
    threadTimeRange(new Date(startMs), endMs === null ? null : new Date(endMs), timeZone);
  /** Link keys carry `:` and `/`; an id referenced by `aria-labelledby` must hold no space. */
  const nameId = (id: string): string => `wc-name-${id.replace(/[^\w-]/g, '_')}`;
  const sessionName = (node: CascadeSessionNode): string =>
    [
      node.title.text ?? 'No title read',
      `${harnessName(node.episode.harness)} session ${node.title.fingerprint}`,
      who(node),
      lineage(node),
      range(node.startMs, node.endMs),
      `span ${span(node.startMs, node.endMs)}`,
      MARK_LABELS[node.mark],
      ...(node.descendants && node.childrenMark
        ? [
            children(node.descendants.count),
            duration(node.descendants),
            `among them: ${MARK_LABELS[node.childrenMark].toLowerCase()}`,
          ]
        : []),
    ].join(', ');
  const burstName = (burst: CascadeBurstNode): string =>
    [
      `${sessions(burst.members.length)} started together at ${threadTime(new Date(burst.startMs), timeZone)}`,
      'no parent read',
      range(burst.startMs, burst.endMs),
      duration(burst.summary),
      `among them: ${MARK_LABELS[burst.mark].toLowerCase()}`,
    ].join(', ');

  const stretchTitle = (stretch: CascadeStretch): string => {
    const start = new Date(stretch.startMs);
    const end = new Date(stretch.endMs);
    // No end was observed for any session: a start alone, never a made-up zero-length range.
    if (stretch.endMs === stretch.startMs) {
      return `${threadDate(start, timeZone, true)} · ${threadTime(start, timeZone)}`;
    }
    const sameDay = threadDayKey(start, timeZone) === threadDayKey(end, timeZone);
    return sameDay
      ? `${threadDate(start, timeZone, true)} · ${threadTime(start, timeZone)}–${threadTime(end, timeZone)}`
      : `${threadDate(start, timeZone, true)}, ${threadTime(start, timeZone)} → ${threadDate(end, timeZone, true)}, ${threadTime(end, timeZone)}`;
  };
  /** A tick names its day when the axis crosses midnight, so 02:00 is never read as the wrong night. */
  const tickDay = (axis: CascadeAxis, tick: number, index: number): string | null => {
    const previous = axis.ticks[index - 1];
    return axis.stepMs < DAY_MS &&
      previous !== undefined &&
      threadDayKey(new Date(previous), timeZone) !== threadDayKey(new Date(tick), timeZone)
      ? threadDate(new Date(tick), timeZone)
      : null;
  };
  /**
   * Day ticks are evenly spaced from the first local midnight, so past a daylight-saving change they
   * sit an hour before or after midnight. The date is read at the nearest midnight, not at the tick.
   */
  const tickLabel = (axis: CascadeAxis, tick: number): string =>
    axis.stepMs >= DAY_MS ? threadDate(new Date(tick + DAY_MS / 2), timeZone) : threadTime(new Date(tick), timeZone);
  /** An event keeps its date whenever the stretch's own heading does not already give it. */
  const milestoneTime = (stretch: CascadeStretch, milestone: CascadeMilestone): string => {
    const at = milestone.entry.at;
    const sameDay =
      stretch.dayKeys.length === 1 && threadDayKey(at, timeZone) === threadDayKey(new Date(stretch.startMs), timeZone);
    return sameDay ? threadTime(at, timeZone) : `${threadDate(at, timeZone)} ${threadTime(at, timeZone)}`;
  };
  const milestoneLabel = (stretch: CascadeStretch, milestone: CascadeMilestone): string =>
    `${milestoneTime(stretch, milestone)} · ${
      milestone.entry.kind === 'fact-event'
        ? threadFactEventCopy(milestone.entry.event).title
        : threadEventCopy(milestone.entry.event, []).title
    }`;
  const place = (axis: CascadeAxis, startMs: number, endMs: number | null): string => {
    const left = cascadeOffset(axis, startMs) * 100;
    const width = endMs === null ? 0 : (cascadeOffset(axis, endMs) - cascadeOffset(axis, startMs)) * 100;
    return `left: ${left.toFixed(3)}%; width: ${width.toFixed(3)}%`;
  };
  const flatten = (node: CascadeSessionNode): readonly CascadeSessionNode[] =>
    node.children.flatMap((child) => [child, ...flatten(child)]);

  const items = (): HTMLElement[] => [...(root?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
  const focusItem = (item: HTMLElement | undefined): void => {
    if (item) {
      activeId = item.dataset.nodeId ?? null;
      item.focus();
    }
  };
  const activate = (item: HTMLElement): void => {
    const id = item.dataset.nodeId;
    if (id === undefined) {
      return;
    }
    if (item.dataset.nodeKind === 'burst') {
      toggle(id);
    } else {
      detailId = detailId === id ? null : id;
    }
  };
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
  const onKeydown = (keyboard: KeyboardEvent): void => {
    const item = keyboard.target;
    // Keys pressed inside an open session panel belong to its buttons, not to the tree.
    if (!(item instanceof HTMLElement) || item.getAttribute('role') !== 'treeitem') {
      return;
    }
    // Up and Down run through the whole cascade, across stretches; Home and End stay in the focused tree.
    const all = items();
    const tree = [...(item.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const index = all.indexOf(item);
    const id = item.dataset.nodeId;
    const expandable = item.hasAttribute('aria-expanded');
    const expanded = item.getAttribute('aria-expanded') === 'true';
    let handled = true;
    if (keyboard.key === 'ArrowDown') {
      focusItem(all[index + 1]);
    } else if (keyboard.key === 'ArrowUp') {
      focusItem(all[index - 1]);
    } else if (keyboard.key === 'Home') {
      focusItem(tree[0]);
    } else if (keyboard.key === 'End') {
      focusItem(tree.at(-1));
    } else if (keyboard.key === 'ArrowRight' && expandable && id !== undefined) {
      if (expanded) {
        focusItem(item.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined);
      } else {
        opened.add(id);
      }
    } else if (keyboard.key === 'ArrowLeft' && expanded && id !== undefined && !expandAll) {
      opened.delete(id);
    } else if (keyboard.key === 'ArrowLeft') {
      focusItem(item.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined);
    } else if (keyboard.key === 'Enter' || keyboard.key === ' ') {
      activate(item);
    } else {
      handled = false;
    }
    if (handled) {
      keyboard.preventDefault();
    }
  };
  const onClick = (mouse: MouseEvent): void => {
    const target = mouse.target;
    if (!(target instanceof Element) || target.closest('.wc-detail')) {
      return;
    }
    const item = target.closest<HTMLElement>('[role="treeitem"]');
    const id = item?.dataset.nodeId;
    if (!(item && id !== undefined)) {
      return;
    }
    activeId = id;
    if (target.closest('[data-twist]')) {
      toggle(id);
    } else {
      activate(item);
    }
  };
  /**
   * One tab stop per tree: the last focused row while it is shown, else the tree's first row. A row
   * hidden by folding its group cannot hold the stop, or the tree would leave the tab order.
   */
  const tabStops = $derived.by(() => {
    const stops = new Set<string>();
    for (const block of blocks) {
      if (block.kind !== 'stretch') {
        continue;
      }
      const shown = new Set<string>();
      const show = (node: CascadeSessionNode): void => {
        shown.add(node.id);
        if (isOpen(node.id)) {
          node.children.forEach(show);
        }
      };
      for (const row of block.rows) {
        if (row.kind === 'session') {
          show(row);
        } else {
          shown.add(row.id);
          if (isOpen(row.id)) {
            row.members.forEach(show);
          }
        }
      }
      const first = block.rows[0]?.id;
      const stop = activeId !== null && shown.has(activeId) ? activeId : first;
      if (stop !== undefined) {
        stops.add(stop);
      }
    }
    return stops;
  });
</script>

{#snippet marks(
  own: CascadeMark | null,
  below: CascadeMark | null,
)}
  <span aria-hidden="true" class="wc-marks">
    {#if own}
      <span class="wc-mark" data-mark={own} title={`This session: ${MARK_LABELS[own].toLowerCase()}`}></span>
    {:else}
      <span class="wc-mark-gap"></span>
    {/if}
    {#if below}
      <span
        class="wc-mark wc-mark-below"
        data-mark={below}
        title={`Among its sessions: ${MARK_LABELS[below].toLowerCase()}`}
      ></span>
    {:else}
      <span class="wc-mark-gap"></span>
    {/if}
  </span>
{/snippet}

{#snippet twist(
  expandable: boolean,
  expanded: boolean,
)}
  {#if expandable}
    <span aria-hidden="true" class="wc-twist" data-twist>{expanded ? '▾' : '▸'}</span>
  {:else}
    <span aria-hidden="true" class="wc-twist"></span>
  {/if}
{/snippet}

{#snippet strips(
  axis: CascadeAxis,
  nodes: readonly CascadeSessionNode[],
)}
  {@const rows = Math.min(nodes.length, MAX_STRIPS)}
  {#each nodes as node, index (node.id)}
    <span
      class="wc-strip"
      data-harness={node.episode.harness}
      data-mark={node.mark}
      style={`${place(axis, node.startMs, node.endMs)}; --wc-strip: ${index % rows}; --wc-strips: ${rows}`}
    ></span>
  {/each}
{/snippet}

{#snippet session(
  node: CascadeSessionNode,
  stretch: CascadeStretch,
  level: number,
)}
  {@const expandable = node.children.length > 0}
  {@const expanded = expandable && isOpen(node.id)}
  {@const shown = detailId === node.id}
  <div
    aria-expanded={ariaExpanded(expandable, expanded)}
    aria-labelledby={nameId(node.id)}
    aria-level={level}
    aria-selected={shown ? 'true' : 'false'}
    class="wc-item wt-episode"
    data-node-id={node.id}
    data-node-kind="session"
    data-session-key={node.id}
    role="treeitem"
    tabindex={tabStops.has(node.id) ? 0 : -1}
  >
    <div class="wc-row" style={`--wc-depth: ${level - 1}`} class:wc-shown={shown}>
      <div class="wc-label">
        {@render twist(expandable, expanded)}
        {@render marks(node.mark, node.childrenMark)}
        <span aria-hidden="true" class="wt-glyph" data-harness={node.episode.harness}
          ><WorkHarnessGlyph harness={node.episode.harness} size={10} /></span
        >
        <span class="wc-title" title={node.title.text ?? 'No title or first prompt was read for this session'}>
          {#if node.title.text}
            <span class="wc-title-text">{node.title.text}</span>
          {/if}
          <code class="wc-id" class:wc-id-alone={node.title.text === null}>{node.title.fingerprint}</code>
          {#if expandable && !expanded && node.descendants}
            <span class="wc-fold">+{children(node.descendants.count)} · {duration(node.descendants)}</span>
          {/if}
        </span>
        <span class="wc-times">{range(node.startMs, node.endMs)}</span>
        <span class="wc-span">{node.endMs === null ? '—' : formatEpisodeDuration(node.endMs - node.startMs)}</span>
      </div>
      <div aria-hidden="true" class="wc-lane">
        <span
          class="wc-bar"
          data-harness={node.episode.harness}
          data-mark={node.mark}
          style={place(stretch.axis, node.startMs, node.endMs)}
        ></span>
        {#if expandable && !expanded}
          <span class="wc-ghosts">{@render strips(stretch.axis, flatten(node))}</span>
        {/if}
      </div>
      <span class="wt-sr" id={nameId(node.id)}>{sessionName(node)}</span>
    </div>
    {#if shown}
      <div class="wc-detail">
        <WorkThreadEpisodeDetail
          {busy}
          episode={node.episode}
          {linkedKeys}
          {links}
          nested={node.episode.launchedBy !== null}
          {onCopy}
          {onDetach}
          {taskTitle}
          {timeZone}
        />
      </div>
    {/if}
    {#if expanded}
      <div class="wc-group" role="group">
        {#each node.children as child (child.id)}
          {@render session(child, stretch, level + 1)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet burst(
  node: CascadeBurstNode,
  stretch: CascadeStretch,
)}
  {@const expanded = isOpen(node.id)}
  <div
    aria-expanded={ariaExpanded(true, expanded)}
    aria-labelledby={nameId(node.id)}
    aria-level={1}
    aria-selected="false"
    class="wc-item"
    data-node-id={node.id}
    data-node-kind="burst"
    role="treeitem"
    tabindex={tabStops.has(node.id) ? 0 : -1}
  >
    <div class="wc-row wc-burst" style="--wc-depth: 0">
      <div class="wc-label">
        {@render twist(true, expanded)}
        {@render marks(null, node.mark)}
        <span aria-hidden="true" class="wt-glyph wc-count">{node.members.length}</span>
        <span class="wc-title" title="Started within the same minute. No parent was read for any of them.">
          <span class="wc-title-text">{node.members.length} started together</span>
          <span class="wc-fold">no parent read · {duration(node.summary)}</span>
        </span>
        <span class="wc-times">{range(node.startMs, node.endMs)}</span>
        <span class="wc-span">{node.endMs === null ? '—' : formatEpisodeDuration(node.endMs - node.startMs)}</span>
      </div>
      <div aria-hidden="true" class="wc-lane">
        {#if !expanded}
          <span class="wc-stack">{@render strips(stretch.axis, node.members)}</span>
        {/if}
      </div>
      <span class="wt-sr" id={nameId(node.id)}>{burstName(node)}</span>
    </div>
    {#if expanded}
      <div class="wc-group" role="group">
        {#each node.members as member (member.id)}
          {@render session(member, stretch, 2)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet row(
  node: CascadeRow,
  stretch: CascadeStretch,
)}
  {#if node.kind === 'burst'}
    {@render burst(node, stretch)}
  {:else}
    {@render session(node, stretch, 1)}
  {/if}
{/snippet}

<div class="wc" bind:this={root}>
  {#each blocks as block (block.id)}
    {#if block.kind === 'interlude'}
      <div class="wc-interlude">
        {#each block.milestones as milestone (milestone.id)}
          <div class="wt-entry">
            <time class="wt-entry-time" datetime={milestone.entry.at}
              >{threadDate(milestone.entry.at, timeZone)}
              {threadTime(milestone.entry.at, timeZone)}</time
            >
            <div class="wt-entry-body">{@render historyEntry(milestone.entry)}</div>
          </div>
        {/each}
      </div>
    {:else}
      {@const cuts = block.milestones.filter((milestone) => milestone.cuts)}
      <section
        aria-label={stretchTitle(block)}
        class="wc-stretch"
        class:wt-selected-day={selectedDay !== null && block.dayKeys.includes(selectedDay)}
      >
        <header class="wc-head">
          <h3 class="wt-day-label">{stretchTitle(block)}</h3>
          <p class="wt-meta">
            {sessions(block.sessionCount)}{block.childCount > 0 ? ` · ${children(block.childCount)}` : ''}
            ·
            {block.endMs === block.startMs
              ? 'end not observed'
              : `${formatEpisodeDuration(block.endMs - block.startMs)} first to last activity`}
          </p>
        </header>
        <div class="wc-body">
          <div aria-hidden="true" class="wc-axis">
            <span class="wc-axis-label">Session</span>
            <div class="wc-scale">
              <!-- The last tick closes the axis; its label would hang past the lane. -->
              {#each block.axis.ticks.slice(0, -1) as tick, index (tick)}
                {@const day = tickDay(block.axis, tick, index)}
                <span class="wc-tick" style={`left: ${(cascadeOffset(block.axis, tick) * 100).toFixed(3)}%`}
                  >{#if day}
                    <span class="wc-tick-day">{day}</span>
                  {/if}
                  {tickLabel(block.axis, tick)}</span
                >
              {/each}
              {#each cuts as milestone (milestone.id)}
                <span
                  class="wc-flag"
                  data-milestone={milestone.entry.kind === 'fact-event' ? milestone.entry.event.kind : 'follow-up'}
                  style={`left: ${(cascadeOffset(block.axis, milestone.atMs) * 100).toFixed(3)}%`}
                  title={milestoneLabel(block, milestone)}
                >
                  {#if milestone.entry.kind === 'fact-event'}
                    <WorkMilestoneGlyph kind={milestone.entry.event.kind} size={10} />
                  {:else}
                    ○
                  {/if}
                </span>
              {/each}
            </div>
          </div>
          <div aria-hidden="true" class="wc-grid">
            {#each block.axis.ticks as tick (tick)}
              <span class="wc-gridline" style={`left: ${(cascadeOffset(block.axis, tick) * 100).toFixed(3)}%`}></span>
            {/each}
            {#each cuts as milestone (milestone.id)}
              <span
                class="wc-cut"
                data-milestone={milestone.entry.kind === 'fact-event' ? milestone.entry.event.kind : 'follow-up'}
                style={`left: ${(cascadeOffset(block.axis, milestone.atMs) * 100).toFixed(3)}%`}
              ></span>
            {/each}
          </div>
          <div
            aria-label={`Sessions, ${stretchTitle(block)}`}
            class="wc-tree"
            onclick={onClick}
            onkeydown={onKeydown}
            role="tree"
            tabindex="-1"
          >
            {#each block.rows as node (node.id)}
              {@render row(node, block)}
            {/each}
          </div>
        </div>
        {#if block.milestones.length > 0}
          <div class="wc-events">
            {#each block.milestones as milestone (milestone.id)}
              <div class="wt-entry">
                <time class="wt-entry-time" datetime={milestone.entry.at}>{milestoneTime(block, milestone)}</time>
                <div class="wt-entry-body">{@render historyEntry(milestone.entry)}</div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/each}
  <div class="wc-legend">
    <span><span aria-hidden="true" class="wc-mark" data-mark="asks"></span> Asks you</span>
    <span><span aria-hidden="true" class="wc-mark" data-mark="unclear"></span> May be asking</span>
    <span><span aria-hidden="true" class="wc-mark" data-mark="running"></span> Running</span>
    <span><span aria-hidden="true" class="wc-mark" data-mark="open-ended"></span> End not observed</span>
    <span><span aria-hidden="true" class="wc-mark" data-mark="quiet"></span> No open request read</span>
    <span
      ><span aria-hidden="true" class="wc-mark wc-mark-below" data-mark="quiet"></span>
      Diamond: among its sessions</span
    >
    <span>Bar: first to last observed activity, pauses included</span>
    <span>↑ ↓ move · → open · ← close · Enter session detail</span>
  </div>
</div>
