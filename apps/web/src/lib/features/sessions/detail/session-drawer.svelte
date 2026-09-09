<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed boolean ARIA values for the controlled Drawer -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  // Wide enough for the rounds rail beside its reading column; the table stays
  // visible on the left so j/k browsing keeps its context.
  const readingDrawer = css({ w: { base: '100vw', md: 'min(960px, max(480px, calc(100vw - 360px)))' } });
  const sessionIdentity = css({ display: 'grid', gap: '6px', minW: 0 });
  const sessionProject = css({ color: 'accent', fontSize: '11px', letterSpacing: '0.02em', overflowWrap: 'anywhere' });
  // Four tiles when the panel is wide, two when it is not: labels never wrap.
  const statStrip = css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '0 16px',
  });
  // Tab triggers live inside the scrolling body, where every control keeps a
  // 44px touch target below `md` (ADR 0005).
  const tabsShell = css({ minW: 0, '& [data-part="trigger"]': { minH: { base: '44px', md: 'auto' } } });
  const pane = css({ display: 'grid', gap: '20px', minW: 0 });
  const tokenSegmentClasses = {
    cacheRead: css({ bg: 'accent', opacity: 0.22 }),
    cacheWrite: css({ bg: 'accent', opacity: 0.42 }),
    input: css({ bg: 'accent', opacity: 0.68 }),
    output: css({ bg: 'accent' }),
  } as const;
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    type BarSegment,
    Drawer,
    drawer,
    drawerActions,
    drawerBody,
    drawerClose,
    drawerCompare,
    drawerGrid,
    drawerLegend,
    drawerLegendItem,
    drawerLegendSwatch,
    drawerLegendValue,
    drawerNav,
    drawerPosition,
    drawerTitle,
    drawerTop,
    ghostButton,
    HarnessBadge,
    muted,
    SegmentBar,
    type TabItem,
    Tabs,
  } from '@ai-usage/design-system/svelte';
  import { provenanceForUsageRow } from '@ai-usage/report-core/provenance';
  import { campaignBadgeLabelForSessionRow, type SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { onDestroy, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { lineDeltaLabel, rtkSavedLabel, rtkSavedTitle } from '../../../../dashboard-sort';
  import { sessionDurationSemantics } from '../../../../session-analysis-model';
  import { fmtCompact, fmtDate, fmtDuration, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import DrawerDetailItem from './drawer-detail-item.svelte';
  import { buildRoundsView } from './rounds-model';
  import RoundsReader from './rounds-reader.svelte';
  import SessionAnalysis from './session-analysis.svelte';
  import SessionVcsSummary from './session-vcs-summary.svelte';
  import type { SessionDetailController, SessionDetailControllerSnapshot } from './types';

  type DetailTab = 'members' | 'rounds' | 'summary' | 'timeline';

  let {
    campaignLabelSlot,
    campaignSlot,
    controller,
    memberRows = [],
    onClosingChange = () => undefined,
    onFieldFilter = () => undefined,
    onSelectMember,
    rows,
    snapshot,
  }: {
    campaignLabelSlot?: Snippet;
    campaignSlot?: Snippet;
    controller: SessionDetailController;
    memberRows?: readonly SessionPresentationRow[];
    onClosingChange?: (closing: boolean) => void;
    onFieldFilter?: (key: 'model' | 'project', value: string) => void;
    onSelectMember?: (row: SessionPresentationRow) => void;
    rows: readonly SessionPresentationRow[];
    snapshot: SessionDetailControllerSnapshot;
  } = $props();

  let closeButton = $state<HTMLButtonElement>();
  const desktopViewport = new MediaQuery('(min-width: 48rem)', false);
  const mobileDrawer = $derived(!desktopViewport.current);
  let previousFocus = $state<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  // Raw: these hold references handed down from a derived selection. A proxied
  // copy would differ from the next snapshot by identity alone and re-run the
  // presenting effect forever.
  let presentedRow = $state.raw<SessionPresentationRow | null>(null);
  let presentedTarget = $state.raw<SessionDetailControllerSnapshot['target']>(null);
  let drawerWasOpen = false;
  let destroyed = false;
  let openHint = $state<symbol | null>(null);
  let closing = $state(false);
  let closeInFlight: Promise<void> | null = null;
  const hintExits = new Map<symbol, { promise: Promise<void>; resolve: () => void }>();
  const drawerOpen = $derived(snapshot.row !== null && snapshot.target !== null);
  const row = $derived(snapshot.row ?? presentedRow);
  const target = $derived(snapshot.target ?? presentedTarget);
  const position = $derived(row ? rows.findIndex((candidate) => candidate.rowId === row.rowId) : -1);
  // Names what the values aggregate, using the same count the row that opened this
  // drawer shows. No automated-review suffix here: the display row cannot tell how many of
  // its rolled-up reviews are already inside `campaignVisibleCount`, and the Members tab
  // states that exactly, from the member list it actually has.
  // A campaign of one (every top-level row is a campaign) gets no extra line.
  const campaignScope = $derived(
    target?.kind === 'campaign-root' && (row?.campaignTotalCount ?? 1) > 1 && row
      ? campaignBadgeLabelForSessionRow(row)
      : null,
  );
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 0) {
      return 0;
    }
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
  };
  const medianCost = $derived(
    median(rows.filter((item) => item.costKnown && item.costApprox > 0).map((item) => item.costApprox)),
  );
  const medianDuration = $derived(median(rows.map((item) => item.durationMs ?? 0).filter((duration) => duration > 0)));
  const costRatio = $derived(
    row?.costKnown && row.costApprox > 0 && medianCost > 0 ? row.costApprox / medianCost : null,
  );
  const durationRatio = $derived(
    row && (row.durationMs ?? 0) > 0 && medianDuration > 0 ? (row.durationMs ?? 0) / medianDuration : null,
  );
  // `costActual` falls back to the API-equivalent estimate whenever the collected cost is itself an
  // approximation, so an equal value carries no charged-amount information and must not be restated
  // under a spend label. Only a provider-reported amount that differs is real charge evidence.
  const chargedAmount = $derived(
    row && row.costActual !== null && row.costActual !== row.costApprox ? row.costActual : null,
  );
  const fmtRatio = (ratio: number): string => (ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`);
  const positionLabel = (): string => {
    if (snapshot.navigation) {
      return `${fmtNum(snapshot.navigation.total)} matching sessions`;
    }
    return position >= 0 ? `${fmtNum(position + 1)} / ${fmtNum(rows.length)}` : 'Outside filters';
  };
  const previousAvailable = $derived(snapshot.navigation ? snapshot.navigation.previous !== null : position > 0);
  const nextAvailable = $derived(
    snapshot.navigation ? snapshot.navigation.next !== null : position >= 0 && position < rows.length - 1,
  );
  const segments = $derived.by((): BarSegment[] =>
    row
      ? [
          { label: 'Cache read', value: row.tokCr, class: tokenSegmentClasses.cacheRead },
          { label: 'Cache write', value: row.tokCw, class: tokenSegmentClasses.cacheWrite },
          { label: 'Input', value: row.tokIn, class: tokenSegmentClasses.input },
          { label: 'Output', value: row.tokOut, class: tokenSegmentClasses.output },
        ]
      : [],
  );
  const partialHint = $derived(
    row
      ? (provenanceForUsageRow(row).find((fact) => fact.kind === 'partial-session')?.description ??
          'Local history did not cover the whole session.')
      : '',
  );
  const durationSemantics = $derived(
    sessionDurationSemantics(row?.source?.harnessKey, target?.kind === 'campaign-root'),
  );

  // The rounds view is derived once per detail response and shared by the tab
  // label and the reader; the reader never re-derives it.
  const availableDetail = $derived(
    snapshot.analysisResponse?.status === 'available' ? snapshot.analysisResponse.detail : null,
  );
  // Without a served revision there is no local history to read, and the reader
  // says so instead of waiting for a load that will never start.
  const unavailableDetail = $derived.by(() => {
    if (snapshot.analysisResponse?.status === 'unavailable') {
      return snapshot.analysisResponse;
    }
    if (snapshot.analysisResponse === null && snapshot.revision === null && !snapshot.analysisLoading) {
      return {
        message: 'This report is not served from a local revision, so its session history cannot be read.',
        reason: 'not-local' as const,
      };
    }
    return null;
  });
  const roundsView = $derived(availableDetail ? buildRoundsView(availableDetail, memberRows) : null);
  const membersAvailable = $derived(campaignScope !== null && campaignSlot !== undefined);
  let activeTab = $state<DetailTab>('rounds');
  // A tab the current target cannot show falls back to the reading view.
  const selectedTab = $derived<DetailTab>(activeTab === 'members' && !membersAvailable ? 'rounds' : activeTab);
  const roundsLabel = $derived(roundsView ? `Rounds · ${fmtNum(roundsView.rounds.length)}` : 'Rounds');
  const membersLabel = $derived(row?.campaignTotalCount ? `Members · ${fmtNum(row.campaignTotalCount)}` : 'Members');
  const tabItems = (panes: Record<DetailTab, Snippet>): TabItem[] => [
    { content: panes.rounds, label: roundsLabel, value: 'rounds' },
    ...(membersAvailable ? [{ content: panes.members, label: membersLabel, value: 'members' }] : []),
    { content: panes.timeline, label: 'Timeline', value: 'timeline' },
    { content: panes.summary, label: 'Summary', value: 'summary' },
  ];
  const isDetailTab = (value: string): value is DetailTab =>
    value === 'members' || value === 'rounds' || value === 'summary' || value === 'timeline';

  $effect.pre(() => {
    const currentOpen = drawerOpen;
    if (currentOpen && !drawerWasOpen) {
      closeInFlight = null;
      closing = false;
      onClosingChange(false);
      previousFocus = typeof document === 'undefined' ? null : document.activeElement;
    }
    drawerWasOpen = currentOpen;
  });

  $effect(() => {
    if (snapshot.row && snapshot.target) {
      if (presentedRow?.rowId !== snapshot.row.rowId) {
        openHint = null;
      }
      presentedRow = snapshot.row;
      presentedTarget = snapshot.target;
      return;
    }
    openHint = null;
  });

  const visibleSessionTrigger = (): HTMLElement | null => {
    if (typeof document === 'undefined' || !row) {
      return null;
    }

    const candidates = document.querySelectorAll<HTMLElement>('[data-session-row-id]');
    for (const candidate of candidates) {
      if (candidate.dataset.sessionRowId !== row.rowId || candidate.getClientRects().length === 0) {
        continue;
      }

      if (candidate.matches('[data-session-index]')) {
        return candidate;
      }

      const mobileTrigger = candidate.querySelector<HTMLElement>('[data-session-index]');
      if (mobileTrigger && mobileTrigger.getClientRects().length > 0) {
        return mobileTrigger;
      }
    }

    return null;
  };

  const previousFocusElement = (): HTMLElement | null => {
    if (
      previousFocus instanceof HTMLElement &&
      previousFocus.isConnected &&
      previousFocus.getClientRects().length > 0
    ) {
      return previousFocus;
    }
    return visibleSessionTrigger();
  };

  const closeDrawer = (): void => {
    try {
      controller.close();
    } finally {
      onClosingChange(false);
    }
  };

  const registerHintExit = (hintId: symbol): void => {
    if (hintExits.has(hintId)) {
      return;
    }
    let resolveExit = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    hintExits.set(hintId, { promise, resolve: resolveExit });
  };

  const handleHintOpenChange = (hintId: symbol, open: boolean): void => {
    if (open) {
      if (closing) {
        return;
      }
      openHint = hintId;
      registerHintExit(hintId);
      return;
    }
    if (openHint === hintId) {
      openHint = null;
    }
  };

  const handleHintSettled = (hintId: symbol): void => {
    const exit = hintExits.get(hintId);
    if (!exit) {
      return;
    }
    hintExits.delete(hintId);
    exit.resolve();
  };

  const completeDrawerClose = async (): Promise<void> => {
    openHint = null;
    await Promise.all([...hintExits.values()].map(({ promise }) => promise));
    if (!destroyed) {
      closeDrawer();
    }
  };

  const closeDrawerAfterHints = (): Promise<void> => {
    if (closeInFlight) {
      return closeInFlight;
    }
    closing = true;
    onClosingChange(true);
    closeInFlight = completeDrawerClose();
    return closeInFlight;
  };

  onDestroy(() => {
    destroyed = true;
    onClosingChange(false);
  });

  const detailHintControl = $derived({
    hintDisabled: closing,
    onHintSettled: handleHintSettled,
    onHintOpenChange: handleHintOpenChange,
    openHint,
  });
</script>

{#snippet roundsPane()}
  <RoundsReader
    error={snapshot.analysisError}
    loading={snapshot.analysisLoading}
    onOpenChild={onSelectMember}
    onRetry={() => controller.retryAnalysis()}
    unavailable={unavailableDetail}
    view={roundsView}
  />
{/snippet}

{#snippet membersPane()}
  <div class={pane} data-session-drawer-members>
    {#if campaignSlot}
      {@render campaignSlot()}
    {/if}
  </div>
{/snippet}

{#snippet timelinePane()}
  {#if row && target}
    <SessionAnalysis
      error={snapshot.analysisError}
      harnessKey={row.source?.harnessKey ?? ''}
      loading={snapshot.analysisLoading}
      onRetry={() => controller.retryAnalysis()}
      response={snapshot.analysisResponse}
      {target}
    />
  {/if}
{/snippet}

{#snippet summaryPane()}
  {#if row && target}
    <div class={pane} data-session-drawer-summary>
      <div>
        <SegmentBar ariaLabel="Token anatomy" {segments} />
        <div class={drawerLegend} style="margin-top: 8px">
          {#each segments as segment (segment.label)}
            <div class={drawerLegendItem} title={`${segment.label}: ${fmtNum(segment.value)} tokens`}>
              <span class={cx(drawerLegendSwatch, segment.class)}></span>
              <span>{segment.label}</span><span class={drawerLegendValue}>{fmtCompact(segment.value)}</span>
            </div>
          {/each}
        </div>
      </div>
      {#if costRatio !== null || durationRatio !== null}
        <div class={drawerCompare} title="Compared with the median session in the current view">
          {#if costRatio !== null}
            ≈ {fmtRatio(costRatio)} median API value
          {/if}
          {#if costRatio !== null && durationRatio !== null}
            ·
          {/if}
          {#if durationRatio !== null}
            {fmtRatio(durationRatio)}
            median duration
          {/if}
        </div>
      {/if}
      <div class={drawerGrid}>
        <DrawerDetailItem {...detailHintControl} label="Started" value={fmtDate(row.date)} />
        <DrawerDetailItem {...detailHintControl} label="Ended" value={fmtDate(row.endDate)} />
        <DrawerDetailItem
          {...detailHintControl}
          hint={rtkSavedTitle(row)}
          label="RTK token savings"
          value={rtkSavedLabel(row)}
        />
        {#if chargedAmount !== null}
          <DrawerDetailItem
            {...detailHintControl}
            hint="Amount this session's source reported as charged. Shown only when it differs from the API-equivalent estimate."
            label="Charged amount"
            value={fmtMoney(chargedAmount)}
          />
        {/if}
        {#if row.harness === 'Cursor' && row.costQuota !== null && row.costQuota !== undefined}
          <!-- Only the Cursor export reports a quota-covered value. Applicability is the source, not
               the number: campaign totals reduce an absent quota to 0, so a non-null value alone
               would still print $0.00 under a Codex campaign. A Cursor zero stays visible. -->
          <DrawerDetailItem
            {...detailHintControl}
            hint="Cursor export value covered by the subscription quota"
            label="Subscription value"
            value={fmtMoney(row.costQuota)}
          />
        {/if}
        <DrawerDetailItem {...detailHintControl} label="Calls" value={fmtNum(row.calls)} />
        <DrawerDetailItem {...detailHintControl} label="Tools" value={fmtNum(row.tools)} />
        <DrawerDetailItem {...detailHintControl} label="Lines" value={lineDeltaLabel(row)} />
        <DrawerDetailItem {...detailHintControl} label="Subagent" value={row.subagent ? 'Yes' : 'No'} />
        {#if row.partial}
          <DrawerDetailItem {...detailHintControl} hint={partialHint} label="Partial" value="Yes" />
        {/if}
        {#if row.usageUnavailable}
          <DrawerDetailItem
            {...detailHintControl}
            hint="Session came from prompt history, but detailed local token counters are missing"
            label="Usage data"
            value="Unavailable"
          />
        {/if}
        {#if row.ambiguous}
          <DrawerDetailItem
            {...detailHintControl}
            hint="Multiple local Cursor sessions matched the same export cluster; totals are best-effort"
            label="Reconciliation"
            value="Ambiguous"
          />
        {/if}
      </div>
      {#if row.source?.vcs}
        <SessionVcsSummary
          context={row.source.vcs}
          onResolve={() => controller.resolveVcs()}
          resolution={snapshot.vcsResolution}
          resolving={snapshot.vcsResolving}
        />
      {/if}
      <div class={drawerActions}>
        <button class={ghostButton} onclick={() => onFieldFilter('project', row.projectKey)} type="button">
          Filter project: {row.projectLabel}
        </button>
        <button class={ghostButton} onclick={() => onFieldFilter('model', row.modelKey)} type="button">
          Filter model: {row.modelKey}
        </button>
      </div>
    </div>
  {/if}
{/snippet}

<Drawer
  closeOnInteractOutside={mobileDrawer}
  contentAriaLabel="Session details"
  contentClass={cx(drawer, readingDrawer)}
  finalFocusEl={previousFocusElement}
  initialFocusEl={() => (mobileDrawer ? (closeButton ?? null) : previousFocusElement())}
  modal={mobileDrawer}
  onOpenChange={(open) => {
    if (!open) {
      return closeDrawerAfterHints();
    }
  }}
  open={drawerOpen}
  preventScroll={mobileDrawer}
  trapFocus={mobileDrawer}
>
  {#if row && target}
    <div class={drawerTop} data-session-drawer-header>
      <span data-session-drawer-harness><HarnessBadge name={row.harness} /></span>
      <nav aria-label={`Session navigation, ${positionLabel()}`} class={drawerNav} data-session-drawer-navigation>
        <span class={drawerPosition} data-session-drawer-position title={positionLabel()}>
          {positionLabel()}
        </span>
        <button
          aria-label="Previous session (k)"
          class={drawerClose}
          disabled={closing || snapshot.navigation?.loading || !previousAvailable}
          onclick={() => controller.navigate(-1)}
          title="Previous session (k)"
          type="button"
        >
          ↑
        </button>
        <button
          aria-label="Next session (j)"
          class={drawerClose}
          disabled={closing || snapshot.navigation?.loading || !nextAvailable}
          onclick={() => controller.navigate(1)}
          title="Next session (j)"
          type="button"
        >
          ↓
        </button>
        <button
          aria-label="Close session details"
          class={drawerClose}
          disabled={closing}
          onclick={closeDrawerAfterHints}
          type="button"
          bind:this={closeButton}
        >
          ✕
        </button>
      </nav>
    </div>
    <div class={drawerBody} data-session-drawer-body>
      <div class={sessionIdentity} data-session-drawer-scope={campaignScope ? 'campaign' : 'session'}>
        <div class={sessionProject}>{row.projectLabel}</div>
        <div class={drawerTitle}>{row.sessionLabel}</div>
        <div class={muted}>{row.providerDisplay} · {row.modelLabel}</div>
        {#if campaignScope}
          <div
            class={muted}
            data-session-drawer-campaign-scope
            title="Values here cover the whole campaign: every session matching the current filters plus its rolled-up automated reviews, including any not listed under Members. Rounds and Timeline read the root session's local history."
          >
            {campaignScope}
          </div>
        {/if}
        {#if campaignLabelSlot}
          {@render campaignLabelSlot()}
        {/if}
      </div>
      <div class={statStrip} data-session-drawer-stats>
        <DrawerDetailItem
          {...detailHintControl}
          hint={apiValuePresentation(row).title}
          label="API value"
          value={apiValuePresentation(row).label}
        />
        <DrawerDetailItem
          {...detailHintControl}
          hint={`Exact token count: ${fmtNum(row.tokenTotal)}`}
          label="Total tokens"
          value={fmtCompact(row.tokenTotal)}
        />
        <DrawerDetailItem
          {...detailHintControl}
          label="Turns"
          value={row.usageUnavailable ? 'Unavailable' : fmtNum(row.turns)}
        />
        <DrawerDetailItem
          {...detailHintControl}
          hint={durationSemantics.metricHint}
          label={durationSemantics.metricLabel}
          value={fmtDuration(row.durationMs)}
        />
      </div>
      <div class={tabsShell} data-session-drawer-tabs>
        <Tabs
          ariaLabel="Session detail views"
          items={tabItems({ members: membersPane, rounds: roundsPane, summary: summaryPane, timeline: timelinePane })}
          onValueChange={(value) => {
            if (isDetailTab(value)) {
              activeTab = value;
            }
          }}
          value={selectedTab}
        />
      </div>
    </div>
  {/if}
</Drawer>
