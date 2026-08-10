<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed boolean ARIA values for the controlled Drawer -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const analysisDrawer = css({ w: { base: '100vw', md: 'min(960px, 94vw)' } });
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
  } from '@ai-usage/design-system/svelte';
  import { provenanceForUsageRow } from '@ai-usage/report-core/provenance';

  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { onDestroy, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { lineDeltaLabel, rtkSavedLabel, rtkSavedTitle } from '../../../../dashboard-sort';
  import { sessionDurationSemantics } from '../../../../session-analysis-model';
  import { fmtCompact, fmtDate, fmtDuration, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import DrawerDetailItem from './drawer-detail-item.svelte';
  import SessionAnalysis from './session-analysis.svelte';
  import SessionVcsSummary from './session-vcs-summary.svelte';
  import type { SessionDetailController, SessionDetailControllerSnapshot } from './types';

  let {
    campaignSlot,
    controller,
    onClosingChange = () => undefined,
    onFieldFilter = () => undefined,
    rows,
    snapshot,
  }: {
    campaignSlot?: Snippet;
    controller: SessionDetailController;
    onClosingChange?: (closing: boolean) => void;
    onFieldFilter?: (key: 'model' | 'project', value: string) => void;
    rows: readonly SessionPresentationRow[];
    snapshot: SessionDetailControllerSnapshot;
  } = $props();

  let closeButton = $state<HTMLButtonElement>();
  let analysisPanel = $state<HTMLDivElement>();
  const desktopViewport = new MediaQuery('(min-width: 48rem)', false);
  const mobileDrawer = $derived(!desktopViewport.current);
  let previousFocus = $state<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  let presentedRow = $state<SessionPresentationRow | null>(null);
  let presentedTarget = $state<SessionDetailControllerSnapshot['target']>(null);
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
  const fmtRatio = (ratio: number): string => (ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`);
  const analysisButtonLabel = (): string => {
    if (snapshot.analysisOpen) {
      return 'Hide analysis';
    }
    return target?.kind === 'session' ? 'Analyze' : 'Analyze root';
  };
  const analysisButtonAriaLabel = (): string => {
    if (snapshot.analysisOpen) {
      return 'Hide session chronology';
    }
    return target?.kind === 'session' ? 'Analyze session chronology' : 'Analyze root session chronology';
  };
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

  const toggleAnalysis = async (): Promise<void> => {
    await controller.toggleAnalysis();
    if (controller.current().analysisOpen) {
      analysisPanel?.scrollIntoView({ block: 'nearest' });
    }
  };
</script>

<Drawer
  closeOnInteractOutside={mobileDrawer}
  contentAriaLabel="Session details"
  contentClass={snapshot.analysisOpen ? cx(drawer, analysisDrawer) : drawer}
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
      <HarnessBadge name={row.harness} />
      <nav aria-label={`Session navigation, ${positionLabel()}`} class={drawerNav} data-session-drawer-navigation>
        <span class={drawerPosition}>
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
        {#if snapshot.revision}
          <button
            aria-controls="session-analysis-panel"
            aria-expanded={snapshot.analysisOpen ? 'true' : 'false'}
            aria-label={analysisButtonAriaLabel()}
            class={ghostButton}
            disabled={closing}
            onclick={toggleAnalysis}
            type="button"
          >
            {analysisButtonLabel()}
          </button>
        {/if}
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
      <div>
        <div class={drawerTitle}>{row.sessionLabel}</div>
        <div class={muted}>{row.providerDisplay} · {row.modelLabel}</div>
      </div>
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
            ≈ {fmtRatio(costRatio)} median cost
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
      {#if campaignSlot}
        {@render campaignSlot()}
      {/if}
      <div class={drawerGrid}>
        <DrawerDetailItem {...detailHintControl} label="Started" value={fmtDate(row.date)} />
        <DrawerDetailItem {...detailHintControl} label="Ended" value={fmtDate(row.endDate)} />
        <DrawerDetailItem
          {...detailHintControl}
          hint={`Exact token count: ${fmtNum(row.tokenTotal)}`}
          label="Total tokens"
          value={fmtCompact(row.tokenTotal)}
        />
        <DrawerDetailItem
          {...detailHintControl}
          hint={rtkSavedTitle(row)}
          label="RTK savings"
          value={rtkSavedLabel(row)}
        />
        <DrawerDetailItem
          {...detailHintControl}
          hint={apiValuePresentation(row).title}
          label="API value"
          value={apiValuePresentation(row).label}
        />
        <DrawerDetailItem
          {...detailHintControl}
          hint="Out-of-pocket spend — $0.00 means covered by a subscription"
          label="Actual cost"
          value={fmtMoney(row.costActual)}
        />
        <DrawerDetailItem
          {...detailHintControl}
          hint="Cursor export value covered by the subscription quota"
          label="Sub value"
          value={fmtMoney(row.costQuota)}
        />
        <DrawerDetailItem {...detailHintControl} label="Calls" value={fmtNum(row.calls)} />
        <DrawerDetailItem
          {...detailHintControl}
          label="Turns"
          value={row.usageUnavailable ? 'Unavailable' : fmtNum(row.turns)}
        />
        <DrawerDetailItem {...detailHintControl} label="Tools" value={fmtNum(row.tools)} />
        <DrawerDetailItem
          {...detailHintControl}
          hint={sessionDurationSemantics(row.source?.harnessKey, target.kind === 'campaign-root').metricHint}
          label={sessionDurationSemantics(row.source?.harnessKey, target.kind === 'campaign-root').metricLabel}
          value={fmtDuration(row.durationMs)}
        />
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
      {#if snapshot.analysisOpen}
        <div id="session-analysis-panel" bind:this={analysisPanel}>
          <SessionAnalysis
            error={snapshot.analysisError}
            harnessKey={row.source?.harnessKey ?? ''}
            loading={snapshot.analysisLoading}
            onRetry={() => controller.retryAnalysis()}
            response={snapshot.analysisResponse}
            {target}
          />
        </div>
      {/if}
    </div>
  {/if}
</Drawer>
