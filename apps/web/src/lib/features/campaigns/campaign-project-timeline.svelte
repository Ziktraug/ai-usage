<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed ARIA states verified by browser regressions. -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { type CampaignMap, type CampaignMapNode, campaignMapTitle } from '@ai-usage/report-core/campaign-map';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { barForInterval, type CampaignTimeline, type CampaignTimelineBar } from './campaign-timeline-model';

  let {
    timeline,
    selectedCampaignKey,
    map,
    mapLoading,
    mapError,
    hasMoreSessions,
    labelFor,
    onSelectCampaign,
    onOpenSession,
    onLoadMoreSessions,
  }: {
    timeline: CampaignTimeline;
    selectedCampaignKey: string;
    map: CampaignMap | null;
    mapLoading: boolean;
    mapError: string | null;
    hasMoreSessions: boolean;
    labelFor: (key: string, derived: string) => string;
    onSelectCampaign: (key: string) => void;
    onOpenSession: (row: SessionPresentationRow) => void;
    onLoadMoreSessions: () => Promise<void>;
  } = $props();

  let collapsedProjects = $state<ReadonlySet<string>>(new Set());
  let expansion = $state<{ key: string; open: boolean } | null>(null);
  const expandedCampaignKey = $derived.by(() => {
    if (expansion?.key === selectedCampaignKey && !expansion.open) {
      return null;
    }
    return selectedCampaignKey;
  });
  const selectCampaign = (key: string): void => {
    expansion = { key, open: true };
    onSelectCampaign(key);
  };
  const toggleCampaign = (key: string): void => {
    if (key !== selectedCampaignKey) {
      selectCampaign(key);
      return;
    }
    expansion = { key, open: expandedCampaignKey !== key };
  };
  const toggleProject = (key: string): void => {
    const next = new Set(collapsedProjects);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    collapsedProjects = next;
  };
  const instant = (value: number): string => `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const sessionInstant = (value: string | null, missing: string): string =>
    value ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : missing;
  const clipLabel = (bar: CampaignTimelineBar): string => {
    if (bar.clippedStart && bar.clippedEnd) {
      return 'Continues beyond both timeline edges';
    }
    if (bar.clippedStart) {
      return 'Started before the visible timeline';
    }
    if (bar.clippedEnd) {
      return 'Continues after the visible timeline';
    }
    return '';
  };
  const nodePrefix = (node: CampaignMapNode): string => {
    if (node.relationship === 'root') {
      return '● ';
    }
    return node.depth > 0 ? '↳ ' : '';
  };
  const nodeRole = (node: CampaignMapNode): string => {
    if (node.relationship === 'root') {
      return 'Root session';
    }
    if (node.relationship === 'review') {
      return 'Automated review';
    }
    if (node.relationship === 'unresolved') {
      return 'Unresolved lineage';
    }
    return `Child session, level ${node.depth}`;
  };

  const surface = css({
    display: 'grid',
    minW: 0,
    mb: '20px',
    border: '1px solid token(colors.line)',
    borderRadius: 'lg',
    overflow: 'hidden',
    bg: 'surface',
  });
  const header = css({
    display: 'grid',
    gap: '8px',
    p: { base: '14px', md: '20px' },
    borderBottom: '1px solid token(colors.line)',
  });
  const heading = css({ fontSize: '18px', fontWeight: 550, m: 0, color: 'ink' });
  const muted = css({ color: 'muted', fontSize: '11px', lineHeight: 1.6 });
  const grid = css({
    display: 'grid',
    gridTemplateColumns: {
      base: 'minmax(120px, .9fr) minmax(105px, 1.1fr)',
      md: 'minmax(220px, .38fr) minmax(0, 1fr)',
    },
    columnGap: { base: '8px', md: '20px' },
    alignItems: 'center',
    minW: 0,
  });
  const axisRow = css({
    py: '12px',
    px: { base: '10px', md: '20px' },
    borderBottom: '1px solid token(colors.line)',
    bg: 'surfaceMuted',
  });
  const axis = css({ position: 'relative', h: '24px', color: 'muted', fontFamily: 'mono', fontSize: '10px' });
  const tick = css({
    position: 'absolute',
    top: 0,
    transform: 'translateX(-50%)',
    whiteSpace: 'nowrap',
    '&:first-child': { transform: 'none' },
    '&:last-child': { transform: 'translateX(-100%)' },
    '&:only-child': { transform: 'none' },
    '&:nth-child(2):not(:last-child)': { display: { base: 'none', md: 'block' } },
  });
  const fullTick = css({ display: { base: 'none', md: 'inline' } });
  const compactTick = css({ display: { base: 'inline', md: 'none' } });
  const screenReader = css({ srOnly: true });
  const group = css({ minW: 0, '& + &': { borderTop: '1px solid token(colors.lineStrong)' } });
  const projectRow = css({ px: { base: '10px', md: '20px' }, py: '10px', bg: 'surfaceMuted' });
  const projectHeading = css({ m: 0, minW: 0 });
  const projectButton = css({
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    minH: '40px',
    w: 'full',
    p: 0,
    textAlign: 'left',
    border: 0,
    bg: 'transparent',
    color: 'ink',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const projectTitle = css({ display: 'block', fontSize: '13px', fontWeight: 650, overflowWrap: 'anywhere' });
  const campaignRow = css({
    px: { base: '10px', md: '20px' },
    py: '9px',
    minH: '68px',
    borderTop: '1px solid token(colors.line)',
  });
  const selectedRow = css({ bg: 'accentTint' });
  const campaignLabel = css({
    display: 'grid',
    gridTemplateColumns: '20px minmax(0, 1fr)',
    gap: '4px',
    alignItems: 'center',
    minW: 0,
  });
  const disclosure = css({
    w: '20px',
    minH: '44px',
    p: 0,
    border: 0,
    bg: 'transparent',
    color: 'muted',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)' },
  });
  const labelButton = css({
    display: 'grid',
    gap: '4px',
    minW: 0,
    minH: '44px',
    w: 'full',
    p: 0,
    textAlign: 'left',
    border: 0,
    bg: 'transparent',
    color: 'ink',
    cursor: 'pointer',
    _hover: { color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const title = css({ fontSize: '12px', fontWeight: 550, lineHeight: 1.45, overflowWrap: 'anywhere' });
  const meta = css({ display: 'block', color: 'muted', fontSize: '10px', lineHeight: 1.5, overflowWrap: 'anywhere' });
  const lane = css({
    display: 'block',
    position: 'relative',
    minW: 0,
    w: 'full',
    h: '32px',
    overflow: 'hidden',
    border: 0,
    borderRadius: 'sm',
    bg: 'track',
    backgroundImage: 'linear-gradient(to right, transparent 49.7%, token(colors.line) 50%, transparent 50.3%)',
  });
  const laneButton = css({
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const bar = css({
    position: 'absolute',
    display: 'block',
    borderRadius: '3px',
    boxSizing: 'border-box',
  });
  const campaignBar = css({ top: '9px', h: '14px', minW: '2px' });
  const projectBar = css({ top: '13px', h: '6px', minW: '2px' });
  const sessionBar = css({ top: '12px', h: '8px', minW: '2px' });
  const pointBar = css({ w: '7px', h: '7px', top: '12px', minW: '7px', transform: 'translateX(-50%) rotate(45deg)' });
  const campaignTone = css({ bg: 'chart.c2' });
  const projectTone = css({ bg: 'chart.c2', opacity: 0.65 });
  const sessionTone = css({ bg: 'chart.c3' });
  const selectedBar = css({ bg: 'accent' });
  const partialBar = css({
    bg: 'transparent',
    border: '1px dashed token(colors.chart.c2)',
    backgroundImage:
      'repeating-linear-gradient(135deg, token(colors.accentTint), token(colors.accentTint) 3px, transparent 3px, transparent 6px)',
  });
  const barTone = (partial: boolean, selected: boolean, normal: string): string => {
    if (partial) {
      return partialBar;
    }
    return selected ? selectedBar : normal;
  };
  const clipStart = css({
    position: 'absolute',
    left: '1px',
    top: '6px',
    color: 'ink',
    fontSize: '16px',
    lineHeight: 1,
  });
  const clipEnd = css({
    position: 'absolute',
    right: '1px',
    top: '6px',
    color: 'ink',
    fontSize: '16px',
    lineHeight: 1,
  });
  const sessions = css({ listStyle: 'none', p: 0, m: 0, bg: 'surfaceMuted' });
  const sessionButton = css({
    w: 'full',
    textAlign: 'left',
    px: { base: '10px', md: '20px' },
    py: '8px',
    minH: '64px',
    border: 0,
    borderTop: '1px solid token(colors.line)',
    bg: 'transparent',
    color: 'ink',
    cursor: 'pointer',
    _hover: { bg: 'accentTint' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
  const sessionLabel = css({ display: 'grid', gap: '3px', minW: 0 });
  const detailNotice = css({
    py: '12px',
    px: { base: '14px', md: '44px' },
    color: 'muted',
    fontSize: '11px',
    lineHeight: 1.6,
    borderTop: '1px solid token(colors.line)',
  });
</script>

<section
  aria-label="Project timeline"
  class={surface}
  data-axis-end={timeline.axis ? new Date(timeline.axis.endMs).toISOString() : undefined}
  data-axis-start={timeline.axis ? new Date(timeline.axis.startMs).toISOString() : undefined}
  data-project-timeline
>
  <header class={header}>
    <h2 class={heading}>Across projects</h2>
    <p class={muted}>Project → campaign → session. Expand a campaign to compare its agents on the same time scale.</p>
    {#if timeline.axis}
      <p class={muted}>{instant(timeline.axis.startMs)} → {instant(timeline.axis.endMs)}</p>
    {/if}
    <p class={muted}>
      Bars show recorded session spans, including idle time. Dashed bars have incomplete timing; arrows mark clipped
      spans.
    </p>
  </header>
  {#if timeline.axis}
    <div class={cx(grid, axisRow)}>
      <span class={muted}>Recorded chronology · UTC</span>
      <div aria-hidden="true" class={axis}>
        {#each timeline.axis.ticks as mark (mark.atMs)}
          <span
            class={tick}
            style:left={`${((mark.atMs - timeline.axis.startMs) / Math.max(1, timeline.axis.endMs - timeline.axis.startMs)) * 100}%`}
            ><span class={fullTick}>{mark.label}</span
            ><span class={compactTick}>{new Date(mark.atMs).toISOString().slice(11, 16)}</span></span
          >
        {/each}
      </div>
    </div>
  {/if}
  {#each timeline.groups as project (project.projectKey)}
    <section
      aria-label={project.projectLabel}
      class={group}
      data-project-key={project.projectKey}
      data-timeline-project
    >
      <div class={cx(grid, projectRow)}>
        <h3 class={projectHeading}>
          <button
            aria-describedby={`timeline-project-count-${encodeURIComponent(project.projectKey)}`}
            aria-expanded={collapsedProjects.has(project.projectKey) ? 'false' : 'true'}
            aria-label={`${collapsedProjects.has(project.projectKey) ? 'Expand' : 'Collapse'} project ${project.projectLabel}`}
            class={projectButton}
            onclick={() => toggleProject(project.projectKey)}
            type="button"
          >
            <span aria-hidden="true">{collapsedProjects.has(project.projectKey) ? '▸' : '▾'}</span>
            <span
              ><span class={projectTitle}>{project.projectLabel}</span
              ><span class={meta} id={`timeline-project-count-${encodeURIComponent(project.projectKey)}`}
                >{project.campaigns.length}
                loaded {project.campaigns.length === 1 ? 'campaign' : 'campaigns'}</span
              ></span
            >
          </button>
        </h3>
        <span aria-hidden="true" class={lane}>
          {#each project.bars as span, index (index)}
            <span
              class={cx(bar, span.point ? pointBar : projectBar, projectTone)}
              data-timeline-project-bar
              style:left={`${span.leftPercent}%`}
              style:width={span.point ? undefined : `${span.widthPercent}%`}
            ></span>
          {/each}
        </span>
      </div>
      {#if !collapsedProjects.has(project.projectKey)}
        {#each project.campaigns as campaign (campaign.item.campaignKey)}
          {@const key = campaign.item.campaignKey}
          {@const label = labelFor(key, campaignMapTitle(campaign.item.row))}
          {@const expanded = expandedCampaignKey === key}
          {@const descriptionId = `timeline-campaign-description-${encodeURIComponent(key)}`}
          <div
            class={cx(grid, campaignRow, selectedCampaignKey === key && selectedRow)}
            data-campaign-key={key}
            data-end={campaign.item.chronology.endedAt}
            data-start={campaign.item.chronology.startedAt}
            data-timeline-campaign
          >
            <div class={campaignLabel}>
              <span class={screenReader} id={descriptionId}>
                {campaign.item.chronology.sessionCount}
                sessions. {campaign.item.row.harness}. Started {campaign.item.chronology.startedAt ?? 'not recorded'}.
                Ended {campaign.item.chronology.endedAt ?? 'not recorded'}. Timing {campaign.timing}.
                {campaign.bar ? clipLabel(campaign.bar) : ''}
                {campaign.outsideRange ? 'Outside visible time window.' : ''}
              </span>
              <button
                aria-expanded={expanded ? 'true' : 'false'}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} sessions for ${label}`}
                class={disclosure}
                onclick={() => toggleCampaign(key)}
                type="button"
              >
                {expanded ? '▾' : '▸'}
              </button>
              <button
                aria-describedby={descriptionId}
                aria-label={`Select campaign ${label}`}
                aria-pressed={selectedCampaignKey === key ? 'true' : 'false'}
                class={labelButton}
                onclick={() => selectCampaign(key)}
                type="button"
              >
                <span class={title}>{label}</span>
                <span class={meta}
                  >{campaign.item.chronology.sessionCount}
                  {campaign.item.chronology.sessionCount === 1 ? 'session' : 'sessions'}
                  ·
                  {campaign.item.row.harness}</span
                >
                {#if campaign.timing === 'partial'}
                  <span class={meta}>Timing incomplete</span>
                {/if}
                {#if campaign.timing === 'unavailable'}
                  <span class={meta}>Timing unavailable</span>
                {/if}
              </button>
            </div>
            {#if campaign.bar}
              <button
                aria-describedby={descriptionId}
                aria-label={`Select campaign timing ${label}`}
                class={cx(lane, laneButton)}
                onclick={() => selectCampaign(key)}
                title={`${campaign.item.chronology.observedFrom ?? ''} → ${campaign.item.chronology.observedTo ?? ''}. ${clipLabel(campaign.bar)}`}
                type="button"
              >
                <span
                  aria-hidden="true"
                  class={cx(bar, campaign.bar.point ? pointBar : campaignBar, barTone(campaign.timing === 'partial', selectedCampaignKey === key, campaignTone))}
                  data-timeline-campaign-bar
                  style:left={`${campaign.bar.leftPercent}%`}
                  style:width={campaign.bar.point ? undefined : `${campaign.bar.widthPercent}%`}
                ></span>
                {#if campaign.bar.clippedStart}
                  <span aria-hidden="true" class={clipStart}>‹</span>
                {/if}
                {#if campaign.bar.clippedEnd}
                  <span aria-hidden="true" class={clipEnd}>›</span>
                {/if}
              </button>
            {:else}
              <span class={meta}>{campaign.outsideRange ? 'Outside visible time window' : 'Timing unavailable'}</span>
            {/if}
          </div>
          {#if expanded}
            {#if map?.campaignKey === key}
              <ol class={sessions}>
                {#each map.nodes as node (node.row.rowId)}
                  {@const nodeBar = barForInterval(node.startMs, node.endMs, timeline.axis)}
                  {@const nodeDescriptionId = `timeline-session-description-${encodeURIComponent(node.row.rowId)}`}
                  <li data-depth={node.depth} data-relationship={node.relationship} data-timeline-session>
                    <button
                      aria-describedby={nodeDescriptionId}
                      aria-label={`Open session ${node.title}`}
                      class={cx(grid, sessionButton)}
                      onclick={() => onOpenSession(node.row)}
                      type="button"
                    >
                      <span class={sessionLabel} style:padding-left={`${Math.min(node.depth + 1, 7) * 10}px`}>
                        <span class={screenReader} id={nodeDescriptionId}>
                          {nodeRole(node)}. {node.row.harness}. {node.row.modelLabel}. Started
                          {node.startedAt ?? 'not recorded'}. Ended {node.endedAt ?? 'not recorded'}.
                          {node.lineageIssue ? `Lineage: ${node.lineageIssue.replaceAll('-', ' ')}.` : ''}
                          {nodeBar ? clipLabel(nodeBar) : ''}
                        </span>
                        <span class={title}>{nodePrefix(node)}{node.title}</span>
                        <span class={meta}>{nodeRole(node)} ·{node.row.modelLabel || node.row.harness}</span>
                        <span class={meta}
                          >{sessionInstant(node.startedAt, 'Start not recorded')}
                          → {sessionInstant(node.endedAt, 'End not recorded')}</span
                        >
                        {#if node.lineageIssue}
                          <span class={meta}>Lineage: {node.lineageIssue.replaceAll('-', ' ')}</span>
                        {/if}
                      </span>
                      {#if nodeBar}
                        <span aria-hidden="true" class={lane}>
                          <span
                            class={cx(bar, nodeBar.point ? pointBar : sessionBar, barTone(node.timingStatus !== 'recorded', node.relationship === 'root', sessionTone))}
                            data-timeline-session-bar
                            style:left={`${nodeBar.leftPercent}%`}
                            style:width={nodeBar.point ? undefined : `${nodeBar.widthPercent}%`}
                          ></span>
                          {#if nodeBar.clippedStart}
                            <span class={clipStart}>‹</span>
                          {/if}
                          {#if nodeBar.clippedEnd}
                            <span class={clipEnd}>›</span>
                          {/if}
                        </span>
                      {:else}
                        <span class={meta}
                          >{node.startedAt || node.endedAt ? 'Outside visible time window' : 'Timing unavailable'}</span
                        >
                      {/if}
                    </button>
                  </li>
                {/each}
              </ol>
              {#if map.omittedCount > 0}
                <p class={detailNotice}>
                  {map.loadedCount}
                  of {map.totalCount} sessions loaded. {map.omittedCount} remain outside this expanded page.
                </p>
              {/if}
              {#if hasMoreSessions}
                <div class={detailNotice}>
                  <button class={ghostButton} disabled={mapLoading} onclick={onLoadMoreSessions} type="button">
                    Load more sessions
                  </button>
                </div>
              {/if}
            {:else if mapLoading}
              <p class={detailNotice} role="status">Loading campaign sessions…</p>
            {:else}
              <p class={detailNotice} role="status">
                {mapError ?? 'Campaign sessions are unavailable in this served revision.'}
              </p>
            {/if}
          {/if}
        {/each}
      {/if}
    </section>
  {/each}
</section>
