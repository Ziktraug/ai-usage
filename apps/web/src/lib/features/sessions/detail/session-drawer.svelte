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
  import Drawer from '@ai-usage/design-system/svelte/drawer';
  import HarnessBadge from '@ai-usage/design-system/svelte/harness-badge';
  import {
    type BarSegment,
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
    muted,
    SegmentBar,
  } from '@ai-usage/design-system/svelte/passive';
  import { provenanceForUsageRow } from '@ai-usage/report-core/provenance';

  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { Snippet } from 'svelte';
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
    onFieldFilter = () => undefined,
    rows,
    snapshot,
  }: {
    campaignSlot?: Snippet;
    controller: SessionDetailController;
    onFieldFilter?: (key: 'model' | 'project', value: string) => void;
    rows: readonly SessionPresentationRow[];
    snapshot: SessionDetailControllerSnapshot;
  } = $props();

  let closeButton = $state<HTMLButtonElement>();
  let analysisPanel = $state<HTMLDivElement>();
  const previousFocus = typeof document === 'undefined' ? null : document.activeElement;
  const row = $derived(snapshot.row);
  const target = $derived(snapshot.target);
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

  const closeDrawer = (): void => {
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    controller.close();
  };

  const toggleAnalysis = async (): Promise<void> => {
    await controller.toggleAnalysis();
    if (controller.current().analysisOpen) {
      analysisPanel?.scrollIntoView({ block: 'nearest' });
    }
  };
</script>

{#if row && target}
  <Drawer
    closeOnInteractOutside
    contentAriaLabel="Session details"
    contentClass={snapshot.analysisOpen ? cx(drawer, analysisDrawer) : drawer}
    finalFocusEl={() => previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : null}
    initialFocusEl={() => closeButton ?? null}
    modal={false}
    onOpenChange={(open) => {
      if (!open) {
        closeDrawer();
      }
    }}
    open
    trapFocus={false}
  >
    <div class={drawerTop}>
      <HarnessBadge name={row.harness} />
      <div class={drawerNav}>
        <span class={drawerPosition}>
          {positionLabel()}
        </span>
        <button
          aria-label="Previous session (k)"
          class={drawerClose}
          disabled={snapshot.navigation?.loading || !previousAvailable}
          onclick={() => controller.navigate(-1)}
          title="Previous session (k)"
          type="button"
        >
          ↑
        </button>
        <button
          aria-label="Next session (j)"
          class={drawerClose}
          disabled={snapshot.navigation?.loading || !nextAvailable}
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
            onclick={toggleAnalysis}
            type="button"
          >
            {analysisButtonLabel()}
          </button>
        {/if}
        <button
          aria-label="Close session details"
          class={drawerClose}
          onclick={closeDrawer}
          type="button"
          bind:this={closeButton}
        >
          ✕
        </button>
      </div>
    </div>
    <div class={drawerBody}>
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
        <DrawerDetailItem label="Started" value={fmtDate(row.date)} />
        <DrawerDetailItem label="Ended" value={fmtDate(row.endDate)} />
        <DrawerDetailItem
          hint={`Exact token count: ${fmtNum(row.tokenTotal)}`}
          label="Total tokens"
          value={fmtCompact(row.tokenTotal)}
        />
        <DrawerDetailItem hint={rtkSavedTitle(row)} label="RTK savings" value={rtkSavedLabel(row)} />
        <DrawerDetailItem
          hint={apiValuePresentation(row).title}
          label="API value"
          value={apiValuePresentation(row).label}
        />
        <DrawerDetailItem
          hint="Out-of-pocket spend — $0.00 means covered by a subscription"
          label="Actual cost"
          value={fmtMoney(row.costActual)}
        />
        <DrawerDetailItem
          hint="Cursor export value covered by the subscription quota"
          label="Sub value"
          value={fmtMoney(row.costQuota)}
        />
        <DrawerDetailItem label="Calls" value={fmtNum(row.calls)} />
        <DrawerDetailItem label="Turns" value={row.usageUnavailable ? 'Unavailable' : fmtNum(row.turns)} />
        <DrawerDetailItem label="Tools" value={fmtNum(row.tools)} />
        <DrawerDetailItem
          hint={sessionDurationSemantics(row.source?.harnessKey, target.kind === 'campaign-root').metricHint}
          label={sessionDurationSemantics(row.source?.harnessKey, target.kind === 'campaign-root').metricLabel}
          value={fmtDuration(row.durationMs)}
        />
        <DrawerDetailItem label="Lines" value={lineDeltaLabel(row)} />
        <DrawerDetailItem label="Subagent" value={row.subagent ? 'Yes' : 'No'} />
        {#if row.partial}
          <DrawerDetailItem hint={partialHint} label="Partial" value="Yes" />
        {/if}
        {#if row.usageUnavailable}
          <DrawerDetailItem
            hint="Session came from prompt history, but detailed local token counters are missing"
            label="Usage data"
            value="Unavailable"
          />
        {/if}
        {#if row.ambiguous}
          <DrawerDetailItem
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
  </Drawer>
{/if}
