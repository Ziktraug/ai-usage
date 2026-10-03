<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte bindings are evaluated at runtime; Playwright verifies the expanded state. -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import type { CampaignMap, CampaignMapNode } from '@ai-usage/report-core/campaign-map';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { fmtCompact } from '../../foundation/presentation/format';

  let { map, onOpen }: { map: CampaignMap; onOpen: (row: SessionPresentationRow) => void } = $props();
  let collapsed = $state<ReadonlySet<string>>(new Set());
  const visibleNodes = $derived.by(() => {
    const hidden = new Set<string>();
    return map.nodes.filter((node) => {
      if (node.parentRowId && (collapsed.has(node.parentRowId) || hidden.has(node.parentRowId))) {
        hidden.add(node.row.rowId);
        return false;
      }
      return true;
    });
  });
  const parents = $derived(new Set(map.nodes.flatMap((node) => (node.parentRowId ? [node.parentRowId] : []))));
  const timedNodes = $derived(map.nodes.filter((node) => node.startMs !== null && node.endMs !== null));
  const start = $derived(Math.min(...timedNodes.map((node) => node.startMs ?? 0)));
  const end = $derived(Math.max(...timedNodes.map((node) => node.endMs ?? 0)));
  const span = $derived(Math.max(1, end - start));
  const time = (value: number): string => new Date(value).toISOString().slice(11, 19);
  const shortInstant = (value: string | null, missing: string): string =>
    value ? `${value.slice(5, 10)} ${value.slice(11, 19)}` : missing;
  const duration = (value: number | null): string => {
    if (value === null) {
      return 'Not recorded';
    }
    if (value < 60_000) {
      return `${Math.round(value / 1000)}s`;
    }
    const minutes = Math.floor(value / 60_000);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const remainder = minutes % 60;
    return `${Math.floor(minutes / 60)}h${remainder ? ` ${remainder}m` : ''}`;
  };
  const relationshipLabel = (node: CampaignMapNode): string => {
    if (node.relationship === 'root') {
      return 'Root session';
    }
    if (node.relationship === 'review') {
      return 'Automated review';
    }
    if (node.relationship === 'unresolved') {
      return 'Unresolved lineage';
    }
    return `Child · level ${node.depth}`;
  };
  const nodePrefix = (node: CampaignMapNode): string => {
    if (node.relationship === 'root') {
      return '● ';
    }
    return node.depth > 0 ? '↳ ' : '';
  };
  const toggle = (rowId: string): void => {
    const next = new Set(collapsed);
    if (next.has(rowId)) {
      next.delete(rowId);
    } else {
      next.add(rowId);
    }
    collapsed = next;
  };

  const outer = css({ display: 'grid', gap: '16px', minW: 0 });
  const heading = css({ fontSize: '20px', fontWeight: 550, lineHeight: 1.35, overflowWrap: 'anywhere' });
  const muted = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6 });
  const metrics = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px 26px',
    borderBottom: '1px solid token(colors.line)',
    pb: '20px',
  });
  const metric = css({ display: 'grid', gap: '3px', fontSize: '13px', fontFamily: 'mono' });
  const label = css({ color: 'muted', fontSize: '10px', fontFamily: 'sans' });
  const list = css({ display: 'grid', listStyle: 'none', p: 0, m: 0 });
  const row = css({
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr)',
    alignItems: 'center',
    borderTop: '1px solid token(colors.line)',
  });
  const toggleClass = css({
    p: 0,
    w: '24px',
    minH: '44px',
    border: 0,
    color: 'muted',
    bg: 'transparent',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)' },
  });
  const nodeButton = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(180px, 0.75fr) minmax(100px, 1fr)' },
    gap: '10px',
    alignItems: 'center',
    minW: 0,
    minH: '74px',
    w: 'full',
    p: '12px 6px',
    border: 0,
    bg: 'transparent',
    textAlign: 'left',
    color: 'ink',
    cursor: 'pointer',
    borderRadius: 'sm',
    _hover: { bg: 'accentTint' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
  const nodeTitle = css({ display: 'block', fontWeight: 550, fontSize: '12px', overflowWrap: 'anywhere' });
  const meta = css({ display: 'block', color: 'muted', fontSize: '10px', lineHeight: 1.6, overflowWrap: 'anywhere' });
  const track = css({
    position: 'relative',
    h: '28px',
    borderRadius: 'sm',
    bg: 'track',
    backgroundImage:
      'linear-gradient(to right, transparent 24.8%, token(colors.line) 25%, transparent 25.2%, transparent 49.8%, token(colors.line) 50%, transparent 50.2%, transparent 74.8%, token(colors.line) 75%, transparent 75.2%)',
  });
  const bar = css({
    position: 'absolute',
    top: '7px',
    h: '14px',
    minW: '3px',
    maxW: 'full',
    borderRadius: '3px',
    bg: 'chart.c2',
  });
  const rootBar = css({ bg: 'accent' });
  const reviewBar = css({ bg: 'chart.c4' });
  const axis = css({
    display: 'flex',
    justifyContent: 'space-between',
    color: 'muted',
    fontFamily: 'mono',
    fontSize: '10px',
    gap: '10px',
  });
  const axisGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(180px, 0.75fr) minmax(100px, 1fr)' },
    alignItems: 'end',
    gap: '10px',
    pl: '30px',
    pr: '6px',
  });
  const axisLabel = css({ display: { base: 'none', lg: 'block' }, color: 'muted', fontSize: '10px' });
  const notice = css({
    bg: 'surfaceMuted',
    p: '10px 12px',
    borderRadius: 'sm',
    color: 'muted',
    fontSize: '12px',
    lineHeight: 1.6,
  });
</script>

<section aria-label="Agent Map" class={outer} data-campaign-map data-testid="campaign-agent-map">
  <div>
    <p class={label}>AGENT MAP</p>
    <h2 class={heading}>{map.title}</h2>
  </div>
  <div class={metrics}>
    <div class={metric}><span class={label}>Sessions</span>{map.loadedCount} / {map.totalCount}</div>
    <div class={metric}>
      <span class={label}>{map.timingComplete ? 'Wall-clock span' : 'Recorded span'}</span>
      {duration(map.timingComplete ? map.wallClockDurationMs : map.observedSpanMs)}
    </div>
    <div class={metric}>
      <span class={label}>Peak overlap</span>
      {map.maxConcurrency === null ? 'Incomplete timing' : `${map.maxConcurrency} sessions`}
    </div>
    <div class={metric}>
      <span class={label}>Tokens in loaded sessions</span>{map.usageComplete ? '' : '≥ '}{fmtCompact(map.tokenTotal)}
    </div>
  </div>
  {#if !map.usageComplete}
    <p class={muted}>Token usage is partial: some session counters or campaign members are unavailable.</p>
  {/if}
  {#if !map.timingComplete}
    <p class={notice}>
      Timing is incomplete. Missing timestamps remain visible, and campaign duration and overlap are not inferred from
      token usage.
    </p>
  {/if}
  {#if timedNodes.length > 0}
    <p class={muted}>
      {new Date(start).toISOString().slice(0, 10)} {time(start)} → {new Date(end).toISOString().slice(0, 10)}
      {time(end)}
      UTC
    </p>
    <div class={axisGrid}>
      <span class={axisLabel}>Session · harness · model</span>
      <div aria-hidden="true" class={axis}>
        <span>{time(start).slice(0, 5)}</span><span>{time(start + span / 2).slice(0, 5)}</span
        ><span>{time(end).slice(0, 5)}</span>
      </div>
    </div>
  {/if}
  <ol class={list}>
    {#each visibleNodes as node, index (node.row.rowId)}
      {@const expanded = !collapsed.has(node.row.rowId)}
      <li class={row} data-campaign-node data-depth={node.depth} data-relationship={node.relationship}>
        {#if parents.has(node.row.rowId)}
          <button
            aria-expanded={expanded}
            aria-label={`${collapsed.has(node.row.rowId) ? 'Expand' : 'Collapse'} descendants of ${node.title}`}
            class={toggleClass}
            onclick={() => toggle(node.row.rowId)}
            type="button"
          >
            {collapsed.has(node.row.rowId) ? '▸' : '▾'}
          </button>
        {:else}
          <span></span>
        {/if}
        <button
          aria-describedby={`campaign-node-description-${index}`}
          aria-label={`Open session ${node.title}`}
          class={nodeButton}
          onclick={() => onOpen(node.row)}
          type="button"
        >
          <span style:padding-left={`${Math.min(node.depth, 8) * 12}px`}>
            <span class={nodeTitle}>{nodePrefix(node)}{node.title}</span>
            <span class={meta} id={`campaign-node-description-${index}`}
              >{relationshipLabel(node)}
              · {node.row.harness} · {node.row.modelLabel || 'Model not recorded'}</span
            >
            <span class={meta}
              >{shortInstant(node.startedAt, 'Start not recorded')}
              → {shortInstant(node.endedAt, 'End not recorded')} UTC ·
              {fmtCompact(node.row.tokenTotal)}
              tokens</span
            >
            {#if node.titleInherited}
              <span class={meta}>Title inherited from campaign</span>
            {/if}
            {#if node.lineageIssue}
              <span class={meta}>Lineage: {node.lineageIssue.replaceAll('-', ' ')}</span>
            {/if}
          </span>
          {#if node.startMs !== null && node.endMs !== null}
            <span aria-hidden="true" class={track}
              ><span
                class={cx(bar, node.relationship === 'root' && rootBar, node.relationship === 'review' && reviewBar)}
                data-campaign-bar
                style:left={`${((node.startMs - start) / span) * 100}%`}
                style:width={`${((node.endMs - node.startMs) / span) * 100}%`}
              ></span></span
            >
          {:else}
            <span class={meta}>Timing {node.timingStatus.replaceAll('-', ' ')}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ol>
  <p class={muted}>
    Recorded session spans · UTC. Overlap shows concurrent session lifetimes; it does not prove continuous agent
    activity.
  </p>
  {#if visibleNodes.length < map.nodes.length}
    <button class={ghostButton} onclick={() => collapsed = new Set()} type="button">
      Show all {map.loadedCount} loaded sessions
    </button>
  {/if}
</section>
